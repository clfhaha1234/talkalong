// Phase A scene composer — deterministic, no LLM.
//
// Why: we want to ship the storybook UI end-to-end before introducing the
// real LLM composer. This stub turns plain input text into a fully-typed
// `ComposedLesson` ready for image-gen + narration. The signature stays
// stable so Phase B can swap in the LLM call without touching callers.
//
// Reuses the existing `splitToSegments` so we don't drift on sentence
// boundaries between orchestrator and lesson paths.

import { splitToSegments } from '@/lib/orchestrator/splitter';
import type { Scene, ComposedLesson } from './types';

export interface ComposeOptions {
  /** Target number of scenes. Defaults to 6. */
  target_scene_count?: number;
  /**
   * Default title when we can't infer one from the input.
   * Defaults to "Tonight's Lesson".
   */
  default_title?: string;
}

const DEFAULT_TARGET_SCENE_COUNT = 6;
const DEFAULT_TITLE = "Tonight's Lesson";
const MAX_TITLE_CHARS = 60;

// Up to 12 — anything beyond falls back to the arabic number string.
const CHAPTER_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six',
  'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
];

const ROMAN_NUMERALS = [
  'I', 'II', 'III', 'IV', 'V', 'VI',
  'VII', 'VIII', 'IX', 'X', 'XI', 'XII',
];

function chapterWord(n: number): string {
  // n is 1-based
  return CHAPTER_WORDS[n - 1] ?? String(n);
}

function romanNumeral(n: number): string {
  // n is 1-based
  return ROMAN_NUMERALS[n - 1] ?? String(n);
}

/**
 * Extract the first sentence-like fragment from a text. Returns the trimmed
 * substring up to (and excluding) the first ., !, or ?. If no terminator is
 * present, returns the entire trimmed text.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const match = trimmed.match(/^[^.!?]+/);
  return (match ? match[0] : trimmed).trim();
}

/**
 * Strip a single trailing punctuation character (., !, ?, ,) if present.
 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?,;:]+$/, '').trim();
}

/**
 * Truncate a string to at most `max` chars, breaking at a word boundary if
 * possible. No ellipsis is appended — the caller decides whether to add one.
 */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Split text into sentences by terminator (. ! ?). Adjacent abbreviations
 * are not specially handled — the orchestrator splitter is the source of
 * truth for that and is consulted first. This is a finer-grained fallback
 * used only when the splitter packed input into fewer chunks than we have
 * scenes.
 */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s.length > 0) out.push(s);
    // Capture the end position BEFORE the next exec call, because once
    // exec returns null the regex's lastIndex resets to 0 and we lose it.
    lastEnd = re.lastIndex;
  }
  // Tail: anything after the last terminator with no terminator of its own.
  const tail = text.slice(lastEnd).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Pack segments into `target` scenes by greedily filling each scene with
 * adjacent segments until its accumulated char count exceeds the per-scene
 * budget. The last scene absorbs any remainder, so we never produce more
 * than `target` scenes.
 */
function packSegmentsIntoScenes(
  segmentTexts: string[],
  target: number,
): string[] {
  if (segmentTexts.length <= target) {
    return segmentTexts.slice();
  }
  const totalChars = segmentTexts.reduce((acc, s) => acc + s.length, 0);
  const perSceneBudget = totalChars / target;
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < segmentTexts.length; i++) {
    const remainingScenes = target - out.length;
    const remainingSegs = segmentTexts.length - i;
    // If we have just enough segments left to fill remaining scenes one-to-one,
    // stop packing — every leftover segment becomes its own scene. This keeps
    // the final scene count exactly equal to `target`.
    if (buf.length > 0 && remainingScenes - 1 >= remainingSegs) {
      out.push(buf);
      buf = '';
    }
    buf = buf.length === 0 ? segmentTexts[i] : `${buf} ${segmentTexts[i]}`;
    // Close the current scene when budget exceeded, but only if we still need
    // more scenes after this one (else we'd overshoot `target`).
    if (buf.length >= perSceneBudget && out.length < target - 1) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) {
    out.push(buf);
  }
  // Defensive: should never trigger given the math above, but keep behavior
  // bounded if it does.
  return out.slice(0, target);
}

/**
 * Break a sentence into two lines at the most natural midpoint:
 *  1. comma nearest the middle, else
 *  2. coordinating conjunction (and/but/or/so/yet) nearest the middle, else
 *  3. whitespace nearest the middle.
 *
 * The first line carries no trailing punctuation; the second line keeps the
 * original sentence's trailing punctuation if any.
 */
function splitHeadline(sentence: string): [string, string] {
  const text = sentence.trim();
  if (text.length === 0) return ['', ''];

  // Detect the original terminator so we can re-attach it to the second line.
  const terminatorMatch = text.match(/[.!?]+$/);
  const terminator = terminatorMatch ? terminatorMatch[0] : '';
  const core = terminator ? text.slice(0, -terminator.length).trim() : text;

  if (!core.includes(' ')) {
    // Single word — put everything on line 2.
    return ['', `${core}${terminator}`];
  }

  const mid = core.length / 2;
  let breakIdx = -1;

  // 1. Comma nearest the middle.
  const commaIdxs: number[] = [];
  for (let i = 0; i < core.length; i++) {
    if (core[i] === ',') commaIdxs.push(i);
  }
  if (commaIdxs.length > 0) {
    commaIdxs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    breakIdx = commaIdxs[0];
  }

  // 2. Conjunction nearest the middle.
  if (breakIdx === -1) {
    const conjRe = /\s(and|but|or|so|yet|because|while|although|whereas)\s/gi;
    const conjIdxs: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = conjRe.exec(core)) !== null) {
      // Break before the conjunction word.
      conjIdxs.push(m.index);
    }
    if (conjIdxs.length > 0) {
      conjIdxs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      breakIdx = conjIdxs[0];
    }
  }

  // 3. Whitespace nearest the middle.
  if (breakIdx === -1) {
    const spaceIdxs: number[] = [];
    for (let i = 0; i < core.length; i++) {
      if (core[i] === ' ') spaceIdxs.push(i);
    }
    if (spaceIdxs.length === 0) {
      return ['', `${core}${terminator}`];
    }
    spaceIdxs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    breakIdx = spaceIdxs[0];
  }

  let first = core.slice(0, breakIdx).trim();
  let second = core.slice(breakIdx).trim();
  // If the break was on a comma, strip the leading comma from the second part.
  if (second.startsWith(',')) second = second.slice(1).trim();
  // Remove trailing punctuation from the first line — headlines aren't
  // sentences.
  first = stripTrailingPunctuation(first);

  return [first, `${second}${terminator}`];
}

/**
 * Phase A composer: deterministic, no LLM. Splits the input text into
 * roughly equal-narration-length scenes, generates fake but on-style
 * chapter/scene headers + image prompts derived from the scene narration.
 *
 * Phase B will replace this with an LLM call. The signature stays.
 */
export function composeLesson(
  input_text: string,
  opts: ComposeOptions = {},
): ComposedLesson {
  const target = opts.target_scene_count ?? DEFAULT_TARGET_SCENE_COUNT;
  const defaultTitle = opts.default_title ?? DEFAULT_TITLE;

  const cleaned = input_text.trim();

  // --- Title ---
  const firstSent = firstSentence(cleaned);
  const titleCandidate = stripTrailingPunctuation(firstSent);
  const title = titleCandidate.length > 0
    ? truncateAtWord(titleCandidate, MAX_TITLE_CHARS)
    : defaultTitle;

  // --- Scene segmentation ---
  // Start from the orchestrator splitter so we share its sentence boundaries.
  // If it returns fewer segments than the target scene count, fall back to
  // splitting on sentence terminators so we have enough granularity to pack
  // into `target` scenes.
  const segments = splitToSegments(cleaned);

  // Edge case: empty input.
  if (segments.length === 0) {
    return {
      title,
      scenes: [],
      full_narration: '',
    };
  }

  let units = segments.map((s) => s.text);
  if (units.length < target) {
    units = sentencesOf(cleaned);
  }
  const sceneTexts = packSegmentsIntoScenes(units, target);

  // --- Build Scene[] ---
  const scenes: Scene[] = sceneTexts.map((narration_text, i) => {
    const idx1 = i + 1;
    const firstLine = firstSentence(narration_text);
    const headline = splitHeadline(firstLine || narration_text);
    return {
      id: `s${idx1}`,
      chapter: `Chapter ${chapterWord(idx1)}`,
      sceneNum: `Scene ${romanNumeral(idx1)}`,
      headline,
      narration_text,
      // Phase A placeholder shape — Phase B will replace with real
      // image-prompt extraction. Intentionally literal.
      image_prompt: `A storybook illustration of: ${firstLine || narration_text}`,
    };
  });

  const full_narration = scenes.map((s) => s.narration_text).join(' ');

  return {
    title,
    scenes,
    full_narration,
  };
}

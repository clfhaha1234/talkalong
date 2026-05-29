// Naive text -> Segment[] splitter for Phase 1.
//
// Heuristic: split on sentence-ending punctuation (. ! ?) while respecting
// quotes and common abbreviations. Then group adjacent short sentences into
// segments of ~120-300 chars so the TTS has chewable but not crawling chunks.
//
// Phase-1 quality is intentionally minimal. The "structuring layer" in PRD §2
// will replace this with an LLM-driven segmenter that also tags categories and
// pre-plants elicitation nodes. For now we tag everything as `exposition` so
// the rest of the pipeline can be built and exercised end-to-end.

import type { Segment, SegmentCategory } from './types';

const TARGET_MIN_CHARS = 80;
const TARGET_MAX_CHARS = 320;

// Naive abbreviation guard — don't split on these.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'e.g', 'i.e', 'etc',
  'fig', 'figs', 'eq', 'no', 'vol', 'pp',
]);

function isLikelyAbbreviation(textBefore: string): boolean {
  // Look at the last whitespace-separated token before the period.
  const match = textBefore.match(/(\S+)\.\s*$/);
  if (!match) return false;
  const tok = match[1].replace(/[^a-zA-Z0-9.]/g, '').toLowerCase();
  return ABBREVIATIONS.has(tok);
}

function categorize(text: string): SegmentCategory {
  if (/\?/.test(text)) return 'question_bearing';
  if (/["“”]/.test(text) || /['‘’]\w/.test(text)) return 'quoted_speech';
  if (/\b\d/.test(text) || /[%=+\-*/]/.test(text)) return 'numbers_symbols';
  if (text.split(/\s+(and|but|although|because|while|whereas|so)\s+/i).length > 2)
    return 'long_compound';
  return 'exposition';
}

/**
 * Split input text into sentence boundaries.
 */
function sentencesOf(text: string): Array<{ text: string; range: [number, number] }> {
  const sentences: Array<{ text: string; range: [number, number] }> = [];
  let cursor = 0;
  let start = 0;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '.' || ch === '!' || ch === '?') {
      const tail = text.slice(start, cursor + 1);
      if (ch === '.' && isLikelyAbbreviation(tail)) {
        cursor++;
        continue;
      }
      // Sentence ends here, but include trailing close-quote / paren.
      let end = cursor + 1;
      while (end < text.length && /[)\]"'”’]/.test(text[end])) end++;
      const segText = text.slice(start, end).trim();
      if (segText.length > 0) sentences.push({ text: segText, range: [start, end] });
      // Skip whitespace before next sentence start
      while (end < text.length && /\s/.test(text[end])) end++;
      start = end;
      cursor = end;
    } else {
      cursor++;
    }
  }
  // Tail
  const tail = text.slice(start).trim();
  if (tail.length > 0) sentences.push({ text: tail, range: [start, text.length] });
  return sentences;
}

/**
 * Pack sentences into segments of ~80-320 chars.
 */
function packSegments(
  sentences: Array<{ text: string; range: [number, number] }>,
): Array<{ text: string; range: [number, number] }> {
  const out: Array<{ text: string; range: [number, number] }> = [];
  let bufText = '';
  let bufStart = -1;
  let bufEnd = -1;
  for (const s of sentences) {
    if (bufText.length === 0) {
      bufText = s.text;
      bufStart = s.range[0];
      bufEnd = s.range[1];
      continue;
    }
    const candidate = `${bufText} ${s.text}`;
    if (candidate.length <= TARGET_MAX_CHARS) {
      bufText = candidate;
      bufEnd = s.range[1];
    } else if (bufText.length < TARGET_MIN_CHARS) {
      // Force-merge even if we go a bit over: we'd rather have a 350-char
      // segment than a 70-char one followed by another 70-char one.
      bufText = candidate;
      bufEnd = s.range[1];
    } else {
      out.push({ text: bufText, range: [bufStart, bufEnd] });
      bufText = s.text;
      bufStart = s.range[0];
      bufEnd = s.range[1];
    }
  }
  if (bufText.length > 0) out.push({ text: bufText, range: [bufStart, bufEnd] });
  return out;
}

export interface SplitOptions {
  /** id prefix for generated segments. Defaults to 's'. */
  idPrefix?: string;
}

export function splitToSegments(text: string, opts: SplitOptions = {}): Segment[] {
  const prefix = opts.idPrefix ?? 's';
  const cleaned = text.trim();
  if (cleaned.length === 0) return [];
  const sentences = sentencesOf(cleaned);
  const packed = packSegments(sentences);
  return packed.map((p, i) => {
    // MiniMax speech_2_8_turbo runs ~17 chars/sec for English narration.
    // Measured empirically during Phase 1 against the actual audio playback.
    // We add a tiny 150ms tail so the audio is fully out before we mark the
    // segment done. Inter-segment pause is handled separately in the narrator.
    const approx_duration_ms =
      Math.max(700, Math.round((p.text.length / 17) * 1000)) + 150;
    return {
      id: `${prefix}${i + 1}`,
      range: { start: p.range[0], end: p.range[1] },
      text: p.text,
      approx_duration_ms,
      category: categorize(p.text),
      elicitation_node: false,
    };
  });
}

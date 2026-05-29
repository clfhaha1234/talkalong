// Phase B script generator — Gemini-Flash-Lite generates a real children's
// storybook script from the user's request, with sha256(input) cache so the
// same request reuses the previous run instantly.
//
// On any LLM failure (network, parse, schema mismatch, timeout), we fall
// back to the deterministic Phase A stub so the UI loop never dies. The
// user might see a less-good story, but they don't see an error screen.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGeminiCompletion } from '@/lib/orchestrator/gemini-client';
import { composeLesson as deterministicCompose } from './scene-composer';
import type { ComposedLesson, Scene } from './types';

const CACHE_SUBDIR = 'public/lesson-cache/scripts';
const DEFAULT_MODEL = process.env.GEMINI_SCRIPT_MODEL ?? 'gemini-3.1-flash-lite';
const LLM_BUDGET_MS = 12000;

const ROMAN = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII',
];
const CHAPTER_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve',
];

const PROMPT_SYSTEM = `You write children's bedtime storybook scripts. The user asks for a topic (a paper, a concept, a chapter, a question) and you turn it into a warm storybook reading.

RULES:
- 5 scenes. Always 5, no more, no less.
- Each scene's narration_text is what a warm narrator reads aloud — 2 to 4 sentences, plain spoken English, age 8-12, about 200-360 characters of speech.
- Never start narration_text with "Okay", "Sure", "Let me", "Let's", "Welcome", "Hello", "I'll", or any meta phrase. Just BE the story.
- Each scene's image_prompt is a single short sentence (60-140 chars) describing one concrete visual moment — characters, posture, key objects. The illustrator will render it in a warm storybook style. Do NOT include style words in the image_prompt (no "watercolor", no "hand-drawn"); just describe what's in the frame.
- Each scene's headline is two short lines, italic-serif feel — a poetic title for the page. Example: ["A curious question", "about time."]
- The full lesson has a title: 3-7 words, evocative.

Output MUST be a valid JSON object with this exact shape:
{
  "title": "string",
  "scenes": [
    { "narration_text": "string", "image_prompt": "string", "headline": ["string","string"] }
    // exactly 5 such objects
  ]
}
Output JSON only — no commentary, no markdown fences, nothing else.`;

interface LlmScript {
  title: string;
  scenes: Array<{
    narration_text: string;
    image_prompt: string;
    headline: [string, string];
  }>;
}

function cacheKey(input: string): string {
  return createHash('sha256').update(input.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function ensureCacheDir(repoRoot: string): string {
  const dir = join(repoRoot, CACHE_SUBDIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readCache(repoRoot: string, key: string): LlmScript | null {
  const file = join(ensureCacheDir(repoRoot), `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LlmScript;
  } catch {
    return null;
  }
}

function writeCache(repoRoot: string, key: string, script: LlmScript): void {
  const file = join(ensureCacheDir(repoRoot), `${key}.json`);
  writeFileSync(file, JSON.stringify(script, null, 2));
}

function parseLlmJson(raw: string): LlmScript {
  // Strip common LLM wrappers (markdown fences, accidental prose) before JSON.parse
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Find the first { and last } to extract the object even if the LLM
  // pre/post-pended commentary.
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('no JSON object in output');
  const obj = JSON.parse(cleaned.slice(first, last + 1)) as Partial<LlmScript>;
  if (!obj.title || typeof obj.title !== 'string') throw new Error('missing title');
  if (!Array.isArray(obj.scenes) || obj.scenes.length < 3) throw new Error('not enough scenes');
  for (const s of obj.scenes) {
    if (!s || typeof s.narration_text !== 'string' || s.narration_text.length < 40) {
      throw new Error('scene narration_text too short or missing');
    }
    if (typeof s.image_prompt !== 'string' || s.image_prompt.length < 20) {
      throw new Error('scene image_prompt too short or missing');
    }
    if (!Array.isArray(s.headline) || s.headline.length !== 2) {
      throw new Error('scene headline must be array of 2');
    }
  }
  return obj as LlmScript;
}

function buildLessonFromScript(script: LlmScript): ComposedLesson {
  const scenes: Scene[] = script.scenes.map((s, i) => {
    const idx = i + 1;
    return {
      id: `s${idx}`,
      chapter: idx <= CHAPTER_WORDS.length ? `Chapter ${CHAPTER_WORDS[idx - 1]}` : `Chapter ${idx}`,
      sceneNum: idx <= ROMAN.length ? `Scene ${ROMAN[idx - 1]}` : `Scene ${idx}`,
      headline: [String(s.headline[0] ?? '').trim(), String(s.headline[1] ?? '').trim()] as [string, string],
      narration_text: s.narration_text.trim(),
      image_prompt: s.image_prompt.trim(),
    };
  });
  const full_narration = scenes.map((s) => s.narration_text).join(' ');
  return { title: script.title.trim(), scenes, full_narration };
}

export interface ComposeWithLlmOptions {
  repoRoot?: string;
  apiKey?: string;
  model?: string;
  /** Set true to bypass cache for debugging. */
  noCache?: boolean;
}

/**
 * Generate a storybook script from user input. Hits the cache first; on miss,
 * calls Gemini. On ANY failure, falls back to the deterministic Phase A stub.
 *
 * Always succeeds — the deterministic fallback is the guarantee.
 */
export async function composeLessonAsync(
  inputText: string,
  opts: ComposeWithLlmOptions = {},
): Promise<{ lesson: ComposedLesson; source: 'cache' | 'llm' | 'fallback'; latency_ms: number }> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const apiKey = opts.apiKey ?? process.env.GOOGLE_API_KEY ?? '';
  const t0 = Date.now();

  const key = cacheKey(inputText);
  if (!opts.noCache) {
    const cached = readCache(repoRoot, key);
    if (cached) {
      return { lesson: buildLessonFromScript(cached), source: 'cache', latency_ms: Date.now() - t0 };
    }
  }

  if (!apiKey) {
    return { lesson: deterministicCompose(inputText), source: 'fallback', latency_ms: Date.now() - t0 };
  }

  const llm = createGeminiCompletion({ apiKey, model: opts.model ?? DEFAULT_MODEL });
  const prompt = `${PROMPT_SYSTEM}\n\nTopic from the listener:\n${inputText.trim()}\n\nJSON:`;

  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('script_llm_budget_exceeded')), LLM_BUDGET_MS),
  );

  try {
    const raw = await Promise.race([llm(prompt), watchdog]);
    const script = parseLlmJson(raw);
    writeCache(repoRoot, key, script);
    return { lesson: buildLessonFromScript(script), source: 'llm', latency_ms: Date.now() - t0 };
  } catch {
    return { lesson: deterministicCompose(inputText), source: 'fallback', latency_ms: Date.now() - t0 };
  }
}

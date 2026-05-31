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
import type { DetectedLanguage, LanguageCode } from '@/lib/language-config';
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

// Language detection for the listener's topic. Used to keep narration_text,
// title and headlines in the SAME language the listener typed — a Chinese
// prompt should yield a Chinese story, not an English one. The previous prompt
// hard-coded "plain spoken English", which silently English-ified every
// non-English topic. We detect CJK first (most common non-English case in our
// userbase), then a few other scripts; everything else falls back to English.
//
// The detection is a heuristic, not a model call — it runs synchronously inside
// composeLessonAsync and the result is logged + cached. If the listener types a
// mixed-language prompt (e.g. "讲一个 Newton 的故事"), the dominant script wins.
// Use the shared DetectedLanguage type from lib/language-config.ts. We keep a
// readable display name (e.g. "Chinese (Simplified or Traditional)") that's
// shown to Gemini in the prompt header — the LanguageCode is the persisted
// discriminator used by voice/STT/persona selectors downstream.
type DetectedLang = DetectedLanguage;
type LangName =
  | 'Chinese (Simplified or Traditional)'
  | 'Japanese'
  | 'Korean'
  | 'Arabic'
  | 'Russian'
  | 'Spanish'
  | 'French'
  | 'German'
  | 'English';
const DISPLAY_NAME: Record<LanguageCode, LangName> = {
  zh: 'Chinese (Simplified or Traditional)',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
  ru: 'Russian',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  en: 'English',
};
const mk = (code: LanguageCode): DetectedLang => ({ code, name: DISPLAY_NAME[code] });

/**
 * Heuristic language detection on the listener's topic text. Exported so
 * lib/language-config.ts callers + unit tests can use it directly.
 *
 * Strategy: Japanese hiragana/katakana > Korean Hangul > generic CJK >
 * Arabic > Cyrillic > Latin (then per-language hints) > English fallback.
 * Japanese-specific check beats generic CJK so a Japanese prompt with kanji
 * doesn't mis-tag as Chinese.
 */
export function detectLanguage(text: string): DetectedLang {
  const sample = text.slice(0, 2000);
  // Count characters in each script's range; the dominant one (over English
  // letters) wins. Japanese hiragana/katakana check beats generic CJK so a
  // Japanese prompt with kanji doesn't get mis-tagged as Chinese.
  const hiraganaKatakana = (sample.match(/[぀-ヿ]/g) ?? []).length;
  const hangul = (sample.match(/[가-힯]/g) ?? []).length;
  const cjkUnified = (sample.match(/[一-鿿]/g) ?? []).length;
  const arabic = (sample.match(/[؀-ۿ]/g) ?? []).length;
  const cyrillic = (sample.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (sample.match(/[a-zA-Z]/g) ?? []).length;

  if (hiraganaKatakana > 0) return mk('ja');
  if (hangul > 0) return mk('ko');
  if (cjkUnified > latin) return mk('zh');
  if (arabic > latin) return mk('ar');
  if (cyrillic > latin) return mk('ru');

  // Latin-script European languages — crude but useful. Look for distinctive
  // accents / words; otherwise English.
  if (/[ñ¡¿]|(\b(el|la|los|las|que|para|pero|porque|cuento|niño|niña)\b)/i.test(sample)) {
    return mk('es');
  }
  if (/[àâçéèêëîïôœùûüÿ]|(\b(le|la|les|une|des|que|pour|mais|parce|enfant|histoire)\b)/i.test(sample)) {
    return mk('fr');
  }
  if (/[äöüß]|(\b(der|die|das|und|aber|weil|kind|geschichte)\b)/i.test(sample)) {
    return mk('de');
  }
  return mk('en');
}

function buildPromptSystem(lang: DetectedLang): string {
  // Narration character budget: CJK characters carry more meaning per code
  // point than Latin letters, so 200-360 Latin chars ≈ 80-150 CJK chars for
  // the same spoken duration. Mis-sizing here makes audio drift either short
  // or long, which surfaces as awkward dead-air gaps or runaway segments.
  const charBudget =
    lang.code === 'zh' || lang.code === 'ja' || lang.code === 'ko'
      ? 'about 80 to 150 characters'
      : 'about 200 to 360 characters';
  // Lead-phrase forbidden list: English meta-phrases the original prompt
  // banned, plus the equivalents in the target language. Without the
  // translated bans, gpt-4o-mini / Gemini happily start with "好的，让我..." or
  // "はい、では..." which sounds robotic for a storybook narrator.
  const bannedLeads =
    lang.code === 'zh'
      ? '"好的"、"好"、"那么"、"让我"、"让我们"、"我来"、"我会"、"欢迎"、"你好"'
      : lang.code === 'ja'
        ? '"はい"、"では"、"それでは"、"承知しました"、"わかりました"、"こんにちは"'
        : lang.code === 'ko'
          ? '"네"、"그럼"、"알겠습니다"、"안녕하세요"'
          : '"Okay", "Sure", "Let me", "Let\'s", "Welcome", "Hello", "I\'ll"';

  return `You write children's bedtime storybook scripts. The user asks for a topic (a paper, a concept, a chapter, a question) and you turn it into a warm storybook reading.

LANGUAGE:
- Write the title, every scene's narration_text, and every scene's headline in ${lang.name}.
- The listener typed their topic in ${lang.name}; match it. If they did not specify a different language, stay in ${lang.name} from start to finish.
- image_prompt MUST be written in plain English regardless of the story language — the image model is English-only. The narration the listener hears stays in ${lang.name}.

RULES:
- 5 scenes. Always 5, no more, no less.
- Each scene's narration_text is what a warm narrator reads aloud — 2 to 4 sentences, plain spoken ${lang.name} suitable for age 8-12, ${charBudget} of speech.
- Never start narration_text with ${bannedLeads}, or any meta phrase. Just BE the story.
- Each scene's image_prompt is a single short ENGLISH sentence (60-140 chars) describing one concrete visual moment — characters, posture, key objects. The illustrator will render it in a warm storybook style. Do NOT include style words in the image_prompt (no "watercolor", no "hand-drawn"); just describe what's in the frame.
- Each scene's headline is two short lines in ${lang.name}, italic-serif feel — a poetic title for the page.
- The full lesson has a title in ${lang.name}: 3-7 words (or equivalent length in ${lang.name}), evocative.

Output MUST be a valid JSON object with this exact shape:
{
  "title": "string",
  "scenes": [
    { "narration_text": "string", "image_prompt": "string", "headline": ["string","string"] }
    // exactly 5 such objects
  ]
}
Output JSON only — no commentary, no markdown fences, nothing else.`;
}

interface LlmScript {
  title: string;
  scenes: Array<{
    narration_text: string;
    image_prompt: string;
    headline: [string, string];
  }>;
}

function cacheKey(input: string, langCode: string): string {
  // langCode is mixed into the digest so a topic that detects differently
  // (e.g. an edge-case mixed-script prompt) doesn't return a stale cross-
  // language hit from before language detection existed. Pre-detection cache
  // entries live under the old key shape and naturally expire on rewrite.
  return createHash('sha256')
    .update(`${langCode}\n${input.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function ensureCacheDir(repoRoot: string): string {
  const dir = join(repoRoot, CACHE_SUBDIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readCache(repoRoot: string, key: string): LlmScript | null {
  // Fully best-effort: on a read-only prod FS (e.g. Vercel, where public/ is
  // immutable) ensureCacheDir's mkdir throws — treat that as a cache miss, not
  // a crash. (This is the dev script cache; regenerating on miss is fine.)
  try {
    const file = join(ensureCacheDir(repoRoot), `${key}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as LlmScript;
  } catch {
    return null;
  }
}

function writeCache(repoRoot: string, key: string, script: LlmScript): void {
  // Best-effort cache write. A read-only FS (Vercel: ENOENT/EROFS on
  // public/lesson-cache) must NOT crash lesson generation — swallow it.
  try {
    const file = join(ensureCacheDir(repoRoot), `${key}.json`);
    writeFileSync(file, JSON.stringify(script, null, 2));
  } catch {
    /* caching is optional; ignore read-only-FS / quota errors */
  }
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

function buildLessonFromScript(
  script: LlmScript,
  lang: DetectedLang,
): ComposedLesson {
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
  return { title: script.title.trim(), scenes, full_narration, language: lang };
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

  // Detect the listener's language ONCE and use it for cache key + prompt.
  // The detection is cheap (sync regex counts), so it always runs even on cache
  // hits — that way the cache key always reflects the detected language and
  // never returns a different-language story from a hash collision.
  const lang = detectLanguage(inputText);
  console.log(`[script-generator] detected language: ${lang.code} (${lang.name}) for input: "${inputText.slice(0, 50)}..."`);

  // Deterministic fallback can't write a Chinese story (it's a string template
  // in English). When it fires we still tag the lesson with the detected lang
  // so downstream voice/STT/persona at least try to match. The narration text
  // itself will be English from the template, which is a known degraded mode.
  const withLang = (lesson: ComposedLesson): ComposedLesson => ({
    ...lesson,
    language: lesson.language ?? lang,
  });

  const key = cacheKey(inputText, lang.code);
  if (!opts.noCache) {
    const cached = readCache(repoRoot, key);
    if (cached) {
      return { lesson: buildLessonFromScript(cached, lang), source: 'cache', latency_ms: Date.now() - t0 };
    }
  }

  if (!apiKey) {
    return { lesson: withLang(deterministicCompose(inputText)), source: 'fallback', latency_ms: Date.now() - t0 };
  }

  const llm = createGeminiCompletion({ apiKey, model: opts.model ?? DEFAULT_MODEL });
  const promptSystem = buildPromptSystem(lang);
  const prompt = `${promptSystem}\n\nTopic from the listener (in ${lang.name}):\n${inputText.trim()}\n\nJSON:`;

  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('script_llm_budget_exceeded')), LLM_BUDGET_MS),
  );

  try {
    const raw = await Promise.race([llm(prompt), watchdog]);
    const script = parseLlmJson(raw);
    writeCache(repoRoot, key, script);
    return { lesson: buildLessonFromScript(script, lang), source: 'llm', latency_ms: Date.now() - t0 };
  } catch {
    return { lesson: withLang(deterministicCompose(inputText)), source: 'fallback', latency_ms: Date.now() - t0 };
  }
}

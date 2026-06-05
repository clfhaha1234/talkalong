// Intent → adapt-the-rest-of-the-story, the /stepfun analogue of /tutor's
// orchestrator rescript. The QA itself stays independent; AFTER it, we ask a
// fast LLM (Gemini lite): did the child's interruption ask for the STORY to
// continue DIFFERENTLY from here (switch language, simpler/scarier, slower,
// focus on a character)? If so, rewrite the not-yet-played scenes accordingly —
// same plot beats, same count, just adapted. Ordinary questions ("what's the
// cat's name?") change nothing.
//
// Watchdog + fail-soft: on timeout / malformed output / no key we return
// { changed: false } and the original narration plays on.
import { createGeminiCompletion } from '@/lib/orchestrator/gemini-client';

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = process.env.STEPFUN_QA_GEMINI_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';

export interface RescriptScene {
  id: string;
  narration: string;
}

export interface RescriptInput {
  question: string;
  answer: string;
  scenes: RescriptScene[]; // the not-yet-played scenes, in order
  budgetMs?: number;
}

export interface RescriptOutcome {
  changed: boolean;
  scenes: RescriptScene[]; // rewritten (only meaningful when changed)
  reason?: string;
}

const SYSTEM = `You decide whether a child's interruption should change how the REST of a bedtime story is told, and if so you rewrite the upcoming scenes.

The child interrupted the narrator with a question; the narrator answered. Now judge ONLY the child's request:
- It SHOULD change the story going forward if it asks for a different DELIVERY of the narration itself — e.g. "tell it in Chinese / 说中文", "make it scarier", "go slower", "use simpler words", "more about the dog".
- It should NOT change anything if it is an ordinary question about the story ("what's the cat's name?", "why is she sad?", "how does it end?") or small talk.

If it should change: rewrite EVERY upcoming scene's narration to apply the request. Keep each scene's plot beats, order, and character names intact — change only language / tone / wording / pace as asked. If switching language, translate fully and naturally (do not leave English behind). Keep each narration roughly its original length.

Output JSON ONLY, no prose, no markdown fences:
{"changed": <true|false>, "scenes": [{"id": "<id>", "narration": "<rewritten>"}]}
When "changed" is false, use "scenes": []. When true, include EVERY input scene id exactly once.`;

function buildPrompt(input: RescriptInput): string {
  const forPrompt = input.scenes.map((s) => ({ id: s.id, narration: s.narration }));
  return `${SYSTEM}

Child asked: "${input.question.trim()}"
Narrator answered: "${input.answer.trim().slice(0, 300)}"
Upcoming scenes (JSON): ${JSON.stringify(forPrompt)}

Output:`;
}

function extractJson(raw: string): { changed?: boolean; scenes?: Array<{ id?: string; narration?: string }> } {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

export async function rescriptRemaining(input: RescriptInput): Promise<RescriptOutcome> {
  const key = process.env.GOOGLE_API_KEY;
  const unchanged: RescriptOutcome = { changed: false, scenes: input.scenes };
  if (!key || input.scenes.length === 0) return unchanged;

  const llm = createGeminiCompletion({
    apiKey: key,
    model: GEMINI_MODEL,
    baseUrl: GEMINI_BASE_URL,
    temperature: 0.3,
    maxTokens: 1600,
  });
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('rescript_budget_exceeded')), input.budgetMs ?? 8000),
  );

  try {
    const raw = await Promise.race([llm(buildPrompt(input)), watchdog]);
    const parsed = extractJson(raw);
    if (!parsed.changed) return unchanged;
    // Map rewrites back onto the originals by id; require every scene present
    // and non-trivial, else fall back to unchanged (a partial rewrite is worse
    // than none — it would mix languages/tones across scenes).
    const rewritten: RescriptScene[] = input.scenes.map((orig) => {
      const found = parsed.scenes?.find((p) => p.id === orig.id);
      if (!found || typeof found.narration !== 'string' || found.narration.trim().length < 8) {
        throw new Error('rescript_missing_or_short_for_' + orig.id);
      }
      return { id: orig.id, narration: found.narration.trim() };
    });
    return { changed: true, scenes: rewritten };
  } catch {
    return unchanged;
  }
}

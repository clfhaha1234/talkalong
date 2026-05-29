// lib/orchestrator/resume-planner.ts
//
// Single LLM call that decides EVERYTHING about how the narration resumes
// after a Q&A digression. Replaces the previous split bridge.ts + rescript.ts
// pipeline.
//
// Three intertwined decisions a real teacher would make at this moment:
//   1. What to say RIGHT NOW to bridge the Q&A back to the story
//      (bridge_text — short, in-character, not a "great question!" preamble)
//   2. Whether to RESTART the interrupted scene, CONTINUE from where audio
//      cut off, or SKIP it (resume_strategy)
//   3. Whether the next 1-2 scenes' content needs to be reshaped given what
//      the listener just asked about (replacement_segments[].text)
//
// Strategy semantics:
//   - 'restart': the listener interrupted early in the scene OR seemed
//      confused, so re-tell the whole scene with the Q&A insight folded in.
//      First replacement_segment.id == paused_scene.id.
//      active_scene_id = paused_scene.id (UI flips back to the paused page).
//
//   - 'continue': the Q&A was a tangent. Pick up where the audio cut off
//      with a natural ~1-sentence reorientation.
//      First replacement_segment.id == paused_scene.id, text covers only the
//      unspoken portion.
//      active_scene_id = paused_scene.id (UI stays on the paused page).
//
//   - 'skip': most of the paused scene already played OR the Q&A made the
//      paused scene's content redundant. Skip past it; replacement_segments
//      starts with next_scenes[0].id.
//      active_scene_id = next_scenes[0].id (UI advances).
//
// The planner gets the FULL paused-scene text plus next 1-2 scenes' text
// plus the QA history so it can judge from content. A %-spoken hint helps
// it decide restart-vs-skip when the listener interrupted mid-scene.
//
// All LLM-generated text is funneled through ONE call so the model can
// keep bridge + replacement coherent (e.g. avoid the bridge promising
// "let's revisit X" while replacement_segments don't mention X).

import { pickBridge } from './bridge-library';
import type { LlmFn } from './gemini-client';

export interface ResumeSceneInput {
  id: string;
  text: string;
}

export interface ResumePlanInput {
  story_title: string;
  paused_scene: ResumeSceneInput;
  /** 0.0 = nothing spoken yet; 1.0 = scene's full audio drained before BRANCH. */
  paused_scene_progress: number;
  /** Up to 2 scenes after the paused one — what would have come next. */
  next_scenes: ResumeSceneInput[];
  qa_history: Array<{ role: 'user' | 'agent'; text: string }>;
}

export type ResumeStrategy = 'restart' | 'continue' | 'skip';

export interface ResumePlan {
  bridge_text: string;
  resume_strategy: ResumeStrategy;
  /**
   * Sequence of segments to replace into ProgressState. Each id MUST match an
   * existing scene id (paused_scene.id or one of next_scenes[].id). The order
   * matches the order they will be spoken.
   */
  replacement_segments: Array<{ id: string; text: string }>;
  /** Which scene the visual page should be on once BRANCH exits. */
  active_scene_id: string;
}

export interface ResumePlannerOptions {
  llm: LlmFn;
  budget_ms: number;
}

export interface ResumePlannerResult {
  plan: ResumePlan;
  source: 'llm' | 'fallback';
  latency_ms: number;
}

const SYSTEM = `You are a storybook tutor's "resume planner". After a child listener has interrupted your reading with questions, you decide how to gracefully resume the story. Think like a great human teacher: respect what the listener just asked, don't ignore it, but also keep the story flowing.

You output ONE JSON object. No prose, no markdown, no fences. Shape:

{
  "bridge_text": "string — 1-2 sentences (60-180 chars). Acknowledge the Q&A in passing AS THE NARRATOR (not as 'great question!'), then re-anchor on where we were. In character — warm storyteller voice. No 'okay', 'sure', 'let me', 'let's'.",
  "resume_strategy": "restart" | "continue" | "skip",
  "replacement_segments": [
    { "id": "string", "text": "string — 2-4 sentences of new narration" }
    // 1-3 entries
  ],
  "active_scene_id": "string"
}

How to pick resume_strategy (this is the heart of teaching judgment):

- "restart" — the listener seemed confused OR they interrupted very early in the scene (less than ~30% spoken). Re-narrate the WHOLE paused scene, weaving in the Q&A insight where it fits. First replacement_segments entry has id = paused scene's id. active_scene_id = paused scene's id.

- "continue" — Q&A was a side tangent and the listener understood. Pick up the unspoken portion of the paused scene. First replacement_segments entry has id = paused scene's id and text covers ONLY what wasn't yet spoken. active_scene_id = paused scene's id.

- "skip" — most of the paused scene already played (>70%) OR the Q&A naturally completed the paused scene's idea. Move forward. First replacement_segments entry has id = next_scenes[0].id. active_scene_id = next_scenes[0].id.

After the first entry, replacement_segments may also include rewritten versions of the next 1-2 scenes if the Q&A changed how they should sound (e.g. listener now knows X, so don't re-explain X). If the next scenes don't need rewriting, you may omit them — the original text will play unchanged. If you DO include them, ids must match next_scenes[].id in order.

Voice rules for replacement_segments[].text and bridge_text:
- Speak AS the storybook narrator. Same warm, age 8-12 voice as the original story.
- Never preface with "Okay", "Sure", "Let me", "Let's", "So", "Alright", "Welcome".
- No bullet points, no lists, no meta-commentary about the lesson.
- If the listener's last message in qa_history requested a language switch (e.g. "用中文讲故事"), mirror that language in bridge_text and in every replacement_segments[].text. Keep the canon — characters, plot beats, scene ids — identical; only the language changes. Otherwise, default to the language of the original story.
- Plain spoken prose. About 200-360 characters per replacement segment (count characters in the chosen language).
- Never narrate the story's later outcome or resolution before the telling reaches it. If a next scene you were given holds the climax or ending, resume TOWARD it without stating how it turns out — preserve the suspense the paused moment still holds.
- Resume with STORY content ONLY. Never fold the listener's off-topic question — arithmetic, numbers, trivia, real-world facts — into bridge_text or any replacement_segments[].text.
- If the listener signalled confusion or asked to hear a part again ("say that again", "I'm lost", "huh", "I don't understand", "start over", "slower"), set resume_strategy to "restart" and re-narrate the paused scene from its own id — do not "continue".`;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildPrompt(input: ResumePlanInput): string {
  const pctSpoken = Math.round(clamp01(input.paused_scene_progress) * 100);
  const qaLines = input.qa_history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'Listener' : 'You'}: ${t.text}`)
    .join('\n');
  const nextLines = input.next_scenes
    .map((s, i) => `  ${i + 1}. id="${s.id}" text="${s.text}"`)
    .join('\n');
  return `${SYSTEM}

Story title: ${input.story_title}

Paused scene (you were reading this when interrupted):
  id="${input.paused_scene.id}"
  text="${input.paused_scene.text}"
  approx_percent_spoken=${pctSpoken}

What would have come next:
${nextLines || '  (no more scenes — paused scene is the last one)'}

Q&A history (most recent at the bottom):
${qaLines || '  (no recorded turns)'}

Now output the JSON plan:`;
}

function parsePlanJson(raw: string): ResumePlan {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('no JSON object');
  const obj = JSON.parse(cleaned.slice(first, last + 1)) as Partial<ResumePlan>;
  if (typeof obj.bridge_text !== 'string' || obj.bridge_text.length < 20) {
    throw new Error('bridge_text invalid');
  }
  if (
    obj.resume_strategy !== 'restart' &&
    obj.resume_strategy !== 'continue' &&
    obj.resume_strategy !== 'skip'
  ) {
    throw new Error('resume_strategy invalid');
  }
  if (!Array.isArray(obj.replacement_segments) || obj.replacement_segments.length === 0) {
    throw new Error('replacement_segments empty');
  }
  for (const r of obj.replacement_segments) {
    if (!r || typeof r.id !== 'string' || typeof r.text !== 'string' || r.text.length < 20) {
      throw new Error('replacement_segment shape invalid');
    }
  }
  if (typeof obj.active_scene_id !== 'string' || !obj.active_scene_id) {
    throw new Error('active_scene_id invalid');
  }
  return obj as ResumePlan;
}

/**
 * Validate the planner's output against the available scene ids — the LLM
 * may hallucinate ids or misorder them. We coerce/reject gracefully.
 */
function validatePlanAgainstInput(plan: ResumePlan, input: ResumePlanInput): ResumePlan {
  const validIds = new Set<string>([
    input.paused_scene.id,
    ...input.next_scenes.map((s) => s.id),
  ]);
  const cleaned = plan.replacement_segments.filter((r) => validIds.has(r.id));
  if (cleaned.length === 0) throw new Error('all replacement_segment ids unknown');

  // Active scene must be one of the known ids
  if (!validIds.has(plan.active_scene_id)) {
    throw new Error('active_scene_id unknown');
  }
  // Strategy must be consistent with the first replacement id
  const firstId = cleaned[0].id;
  if (plan.resume_strategy === 'skip' && firstId === input.paused_scene.id) {
    // Strategy claims skip but first segment is the paused one — downgrade
    // to 'continue' to keep the structure consistent.
    plan = { ...plan, resume_strategy: 'continue' };
  }
  if (plan.resume_strategy !== 'skip' && firstId !== input.paused_scene.id) {
    // restart/continue should both start with paused scene
    plan = { ...plan, resume_strategy: 'skip' };
  }
  return { ...plan, replacement_segments: cleaned };
}

function fallbackPlan(input: ResumePlanInput): ResumePlan {
  const pctSpoken = clamp01(input.paused_scene_progress);
  // Mostly played → skip; otherwise restart so listener doesn't lose the thread.
  const strategy: ResumeStrategy =
    pctSpoken > 0.7 || input.next_scenes.length === 0 ? 'skip' : 'restart';
  const replacement_segments: Array<{ id: string; text: string }> =
    strategy === 'skip'
      ? input.next_scenes.length > 0
        ? [input.next_scenes[0]]
        : [input.paused_scene] // degenerate; shouldn't happen
      : [input.paused_scene];
  const active_scene_id =
    strategy === 'skip' && input.next_scenes[0]
      ? input.next_scenes[0].id
      : input.paused_scene.id;
  return {
    bridge_text: pickBridge(),
    resume_strategy: strategy,
    replacement_segments,
    active_scene_id,
  };
}

/**
 * Plan how the story resumes after a Q&A digression. ONE LLM call. Always
 * succeeds — on any failure (network / parse / validation / budget exceeded)
 * we synthesize a reasonable plan from the input alone.
 */
export async function planResume(
  input: ResumePlanInput,
  opts: ResumePlannerOptions,
): Promise<ResumePlannerResult> {
  const t0 = Date.now();
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('resume_planner_budget_exceeded')), opts.budget_ms),
  );
  try {
    const raw = await Promise.race([opts.llm(buildPrompt(input)), watchdog]);
    const parsed = parsePlanJson(raw);
    const validated = validatePlanAgainstInput(parsed, input);
    return { plan: validated, source: 'llm', latency_ms: Date.now() - t0 };
  } catch {
    return { plan: fallbackPlan(input), source: 'fallback', latency_ms: Date.now() - t0 };
  }
}

// Parameterized copy of resume-planner.ts for the QA bench.
// Same parsing + validation as prod; the SYSTEM prompt is injected at call
// time so the bench can iterate prompts without forking the prod module.

import type { LlmFn } from '../../lib/orchestrator/gemini-client';

export interface ResumeSceneInput {
  id: string;
  text: string;
}

export interface ResumePlanInput {
  story_title: string;
  paused_scene: ResumeSceneInput;
  paused_scene_progress: number;
  next_scenes: ResumeSceneInput[];
  qa_history: Array<{ role: 'user' | 'agent'; text: string }>;
}

export type ResumeStrategy = 'restart' | 'continue' | 'skip';

export interface ResumePlan {
  bridge_text: string;
  resume_strategy: ResumeStrategy;
  replacement_segments: Array<{ id: string; text: string }>;
  active_scene_id: string;
}

export interface PlanResumeOpts {
  llm: LlmFn;
  budget_ms: number;
  system: string;
}

export interface PlanResumeResult {
  plan: ResumePlan;
  source: 'llm' | 'fallback';
  latency_ms: number;
  raw?: string;
  error?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildPrompt(system: string, input: ResumePlanInput): string {
  const pctSpoken = Math.round(clamp01(input.paused_scene_progress) * 100);
  const qaLines = input.qa_history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'Listener' : 'You'}: ${t.text}`)
    .join('\n');
  const nextLines = input.next_scenes
    .map((s, i) => `  ${i + 1}. id="${s.id}" text="${s.text}"`)
    .join('\n');
  return `${system}

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
  if (obj.resume_strategy !== 'restart' && obj.resume_strategy !== 'continue' && obj.resume_strategy !== 'skip') {
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

function validatePlanAgainstInput(plan: ResumePlan, input: ResumePlanInput): ResumePlan {
  const validIds = new Set<string>([
    input.paused_scene.id,
    ...input.next_scenes.map((s) => s.id),
  ]);
  const cleaned = plan.replacement_segments.filter((r) => validIds.has(r.id));
  if (cleaned.length === 0) throw new Error('all replacement_segment ids unknown');
  if (!validIds.has(plan.active_scene_id)) throw new Error('active_scene_id unknown');
  const firstId = cleaned[0].id;
  if (plan.resume_strategy === 'skip' && firstId === input.paused_scene.id) {
    plan = { ...plan, resume_strategy: 'continue' };
  }
  if (plan.resume_strategy !== 'skip' && firstId !== input.paused_scene.id) {
    plan = { ...plan, resume_strategy: 'skip' };
  }
  return { ...plan, replacement_segments: cleaned };
}

function fallbackPlan(input: ResumePlanInput): ResumePlan {
  const pctSpoken = clamp01(input.paused_scene_progress);
  const strategy: ResumeStrategy =
    pctSpoken > 0.7 || input.next_scenes.length === 0 ? 'skip' : 'restart';
  const replacement_segments: Array<{ id: string; text: string }> =
    strategy === 'skip'
      ? input.next_scenes.length > 0
        ? [input.next_scenes[0]]
        : [input.paused_scene]
      : [input.paused_scene];
  const active_scene_id =
    strategy === 'skip' && input.next_scenes[0]
      ? input.next_scenes[0].id
      : input.paused_scene.id;
  return {
    bridge_text: '... and now, back to our story.',
    resume_strategy: strategy,
    replacement_segments,
    active_scene_id,
  };
}

export async function planResume(input: ResumePlanInput, opts: PlanResumeOpts): Promise<PlanResumeResult> {
  const t0 = Date.now();
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('resume_planner_budget_exceeded')), opts.budget_ms),
  );
  let raw = '';
  try {
    raw = await Promise.race([opts.llm(buildPrompt(opts.system, input)), watchdog]);
    const parsed = parsePlanJson(raw);
    const validated = validatePlanAgainstInput(parsed, input);
    return { plan: validated, source: 'llm', latency_ms: Date.now() - t0, raw };
  } catch (err) {
    return {
      plan: fallbackPlan(input),
      source: 'fallback',
      latency_ms: Date.now() - t0,
      raw,
      error: (err as Error).message,
    };
  }
}

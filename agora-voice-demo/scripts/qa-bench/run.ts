// QA bench runner.
//
// For each case in cases.json:
//   1. Simulate the persona-driven QA answer by calling Gemini with
//      (persona + story-so-far + listener question).
//   2. Call the parameterized resume-planner with (story title, paused
//      scene, paused %, next scenes, qa_history).
//   3. Persist {qa_answer, plan, source, latency_ms} per case.
//
// Usage:
//   pnpm tsx scripts/qa-bench/run.ts \
//     --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
//     --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/baseline.json \
//     [--only C1,C2a]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env';
import { createGeminiCompletion } from '../../lib/orchestrator/gemini-client';
import { createOpenAICompletion } from './openai-client';
import { createAnthropicCompletion } from './anthropic-client';
import { planResume } from './planner';

interface Scene { id: string; text: string }
interface Fixture { story_title: string; scenes: Scene[] }
interface CaseSpec {
  id: string;
  label: string;
  source: string;
  trigger_scene: string;
  paused_pct: number;
  qa_question: string;
  rubric: unknown;
}
interface PromptsFile { persona: string; planner_system: string }
interface CaseResult {
  case_id: string;
  label: string;
  trigger_scene: string;
  paused_pct: number;
  qa_question: string;
  story_so_far_scene_ids: string[];
  qa_answer: string;
  qa_latency_ms: number;
  qa_error?: string;
  planner_input_summary: {
    paused_scene_id: string;
    paused_scene_progress: number;
    next_scene_ids: string[];
  };
  planner_plan: unknown;
  planner_source: string;
  planner_latency_ms: number;
  planner_raw?: string;
  planner_error?: string;
}

function parseArgs(): {
  prompts: string;
  out: string;
  only?: string[];
  trials: number;
  qaModel: string;
  casesPath?: string;
  fixturePath?: string;
  plannerModel?: string;
  redactEnding: boolean;
} {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const prompts = get('--prompts');
  const out = get('--out');
  const only = get('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const trials = Number(get('--trials') ?? '1');
  // --qa-model formats: "gemini" (default) or "openai:<model>" e.g. "openai:gpt-5-mini"
  const qaModel = get('--qa-model') ?? 'gemini';
  // --cases overrides the case set (rubric + questions). --fixture overrides
  // the story fixture (scenes + optional canon_summary). Defaults to the
  // fairy-tale dev set; cross-domain runs (B9) pass --fixture <domain>.json.
  const casesPath = get('--cases');
  const fixturePath = get('--fixture');
  // R3 arms: --planner-model overrides the planner LLM; --redact-ending truncates
  // the story's FINAL scene in the planner's lookahead so it can't leak the ending.
  const plannerModel = get('--planner-model');
  const redactEnding = args.includes('--redact-ending');
  if (!prompts || !out) {
    throw new Error('usage: --prompts <path> --out <path> [--only id1,id2] [--trials N] [--qa-model gemini|openai:<model>] [--cases <path>] [--fixture <path>] [--planner-model <id>] [--redact-ending]');
  }
  return { prompts, out, only, trials: Number.isFinite(trials) && trials > 0 ? trials : 1, qaModel, casesPath, fixturePath, plannerModel, redactEnding };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');
const expDir = join(repoRoot, 'docs/experiments/2026-05-28-qa-resume-benchmark');

function buildQaPrompt(persona: string, fixture: Fixture, triggerSceneId: string, listenerQ: string): string {
  const triggerIdx = fixture.scenes.findIndex((s) => s.id === triggerSceneId);
  if (triggerIdx < 0) throw new Error(`unknown trigger_scene ${triggerSceneId}`);
  const storySoFar = fixture.scenes.slice(0, triggerIdx + 1).map((s) => s.text).join('\n\n');
  return `${persona}

You are reading the storybook "${fixture.story_title}" to a child. So far you have just read this aloud:

"""
${storySoFar}
"""

The child interrupts and says: "${listenerQ}"

Answer the child as the storybook narrator in at most 2 short sentences. Stay strictly in narrator voice (no meta-commentary, no "okay" / "sure" / "let me" / "let's continue"). Reply with ONLY the spoken answer, no quotes, no labels.`;
}

async function runOneCase(
  c: CaseSpec,
  fixture: Fixture,
  persona: string,
  plannerSystem: string,
  qaLlm: ReturnType<typeof createGeminiCompletion>,
  plannerLlm: ReturnType<typeof createGeminiCompletion>,
  trial: number,
  redactEnding: boolean,
): Promise<CaseResult> {
  const triggerIdx = fixture.scenes.findIndex((s) => s.id === c.trigger_scene);
  if (triggerIdx < 0) throw new Error(`unknown trigger_scene in case ${c.id}: ${c.trigger_scene}`);
  const storySoFarIds = fixture.scenes.slice(0, triggerIdx + 1).map((s) => s.id);

  // Step 1: simulate the QA answer.
  let qaAnswer = '';
  let qaErr: string | undefined;
  const qaT0 = Date.now();
  try {
    qaAnswer = await qaLlm(buildQaPrompt(persona, fixture, c.trigger_scene, c.qa_question));
  } catch (err) {
    qaErr = (err as Error).message;
  }
  const qaLatency = Date.now() - qaT0;

  // Step 2: call the resume planner.
  const pausedScene = fixture.scenes[triggerIdx];
  const nextScenes = fixture.scenes.slice(triggerIdx + 1, triggerIdx + 3);
  const lastIdx = fixture.scenes.length - 1;
  const plannerInput = {
    story_title: fixture.story_title,
    paused_scene: { id: pausedScene.id, text: pausedScene.text },
    paused_scene_progress: c.paused_pct,
    next_scenes: nextScenes.map((s) => {
      // ARM A (workflow): redact the story's FINAL scene in lookahead — give only
      // its first sentence so the planner can transition toward the ending without
      // being handed (and leaking) its outcome.
      if (redactEnding && fixture.scenes.findIndex((x) => x.id === s.id) === lastIdx) {
        const firstSentence = s.text.split(/(?<=[.!?])\s/)[0] ?? s.text;
        return { id: s.id, text: firstSentence };
      }
      return { id: s.id, text: s.text };
    }),
    qa_history: [
      { role: 'user' as const, text: c.qa_question },
      { role: 'agent' as const, text: qaAnswer },
    ],
  };
  const planResult = await planResume(plannerInput, {
    llm: plannerLlm,
    budget_ms: 60_000,
    system: plannerSystem,
  });

  return {
    case_id: c.id + (trial > 1 ? `_t${trial}` : ''),
    label: c.label,
    trigger_scene: c.trigger_scene,
    paused_pct: c.paused_pct,
    qa_question: c.qa_question,
    story_so_far_scene_ids: storySoFarIds,
    qa_answer: qaAnswer,
    qa_latency_ms: qaLatency,
    qa_error: qaErr,
    planner_input_summary: {
      paused_scene_id: pausedScene.id,
      paused_scene_progress: c.paused_pct,
      next_scene_ids: nextScenes.map((s) => s.id),
    },
    planner_plan: planResult.plan,
    planner_source: planResult.source,
    planner_latency_ms: planResult.latency_ms,
    planner_raw: planResult.raw,
    planner_error: planResult.error,
  };
}

async function main() {
  const { prompts: promptsPath, out: outPath, only, trials, qaModel, casesPath, fixturePath, plannerModel, redactEnding } = parseArgs();
  const fixture = JSON.parse(readFileSync(fixturePath ?? join(expDir, 'fixture.json'), 'utf8')) as Fixture;
  const cases = JSON.parse(readFileSync(casesPath ?? join(expDir, 'cases.json'), 'utf8')).cases as CaseSpec[];
  const promptsFile = JSON.parse(readFileSync(promptsPath, 'utf8')) as PromptsFile;
  const selected = only ? cases.filter((c) => only.includes(c.id)) : cases;
  if (selected.length === 0) throw new Error('no cases selected');

  // Planner ALWAYS runs on Gemini (matches prod server-side reality).
  // --planner-model overrides the model (R3 arm B); defaults to the prod model.
  const plannerModelId = plannerModel ?? env.geminiModel;
  const plannerLlm = createGeminiCompletion({
    apiKey: env.geminiApiKey,
    model: plannerModelId,
    temperature: 0.7,
    maxTokens: 1024,
  });

  // QA-answer LLM follows --qa-model. Default = Gemini (same as planner);
  // pass `openai:<model>` to match the managed-Agora-agent LLM in prod.
  let qaLlm = plannerLlm;
  let qaModelLabel = env.geminiModel;
  if (qaModel.startsWith('openai:')) {
    const model = qaModel.slice('openai:'.length);
    if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY missing — set it in .env.local');
    qaLlm = createOpenAICompletion({
      apiKey: env.openaiApiKey,
      model,
      temperature: 0.7,
      maxTokens: 512,
    });
    qaModelLabel = `openai:${model}`;
  } else if (qaModel.startsWith('anthropic:')) {
    const model = qaModel.slice('anthropic:'.length);
    if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY missing — set it in .env.local');
    qaLlm = createAnthropicCompletion({
      apiKey: env.anthropicApiKey,
      model,
      temperature: 0.7,
      maxTokens: 512,
    });
    qaModelLabel = `anthropic:${model}`;
  } else if (qaModel !== 'gemini') {
    throw new Error(`unknown --qa-model: ${qaModel} (use "gemini", "openai:<model>", or "anthropic:<model>")`);
  }

  console.log(`[bench] qa_model=${qaModelLabel} planner_model=${plannerModelId}${redactEnding ? ' redact_ending=on' : ''} cases=${selected.length} trials=${trials} prompts=${promptsPath}`);

  const results: CaseResult[] = [];
  for (const c of selected) {
    for (let t = 1; t <= trials; t++) {
      const label = `${c.id}${trials > 1 ? `/t${t}` : ''}`;
      process.stdout.write(`  - ${label} (${c.label})... `);
      const r = await runOneCase(c, fixture, promptsFile.persona, promptsFile.planner_system, qaLlm, plannerLlm, t, redactEnding);
      results.push(r);
      const tag = `${r.planner_source}/${(r.planner_plan as { resume_strategy: string }).resume_strategy}`;
      console.log(`qa=${r.qa_latency_ms}ms planner=${r.planner_latency_ms}ms ${tag}`);
    }
  }

  const meta = {
    run_at: new Date().toISOString(),
    qa_model: qaModelLabel,
    planner_model: env.geminiModel,
    prompts_path: promptsPath.replace(repoRoot + '/', ''),
    fixture_path: (fixturePath ?? join(expDir, 'fixture.json')).replace(repoRoot + '/', ''),
    cases_path: (casesPath ?? join(expDir, 'cases.json')).replace(repoRoot + '/', ''),
    out_path: outPath.replace(repoRoot + '/', ''),
    trials,
    n_cases: selected.length,
    n_results: results.length,
  };
  writeFileSync(outPath, JSON.stringify({ meta, results }, null, 2));
  console.log(`[bench] wrote ${outPath}`);
}

main().catch((err) => {
  console.error('[bench] fatal:', err);
  process.exit(1);
});

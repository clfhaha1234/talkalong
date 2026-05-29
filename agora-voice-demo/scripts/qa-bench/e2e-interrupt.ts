// E2E interrupt harness for the QA→resume pipeline.
//
// Difference vs. run.ts:
//   - Calls the PROD planner (lib/orchestrator/resume-planner.ts), not the
//     parameterized bench copy. The point is to surface prompt regressions
//     in the shipped path, not in an arm prompt file.
//   - Applies the case rubric's mechanical hard rules (substring presence /
//     absence + expected_strategy) and produces PASS/FAIL.
//   - Adds a C1-specific Han-character detector on bridge_text and on each
//     replacement_segments[].text — the bug that was masked by the offline
//     bench (which only judges qa_answer).
//
// Usage:
//   pnpm tsx scripts/qa-bench/e2e-interrupt.ts                 # default set
//   pnpm tsx scripts/qa-bench/e2e-interrupt.ts --only C1
//   pnpm tsx scripts/qa-bench/e2e-interrupt.ts --all
//   pnpm tsx scripts/qa-bench/e2e-interrupt.ts --qa-model openai:gpt-4o-mini
//
// Default set: C1, C2a, C2b, C3 — the four cases the team uses as a smoke set.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env';
import { createGeminiCompletion } from '../../lib/orchestrator/gemini-client';
import { createOpenAICompletion } from './openai-client';
import { createAnthropicCompletion } from './anthropic-client';
import { planResume } from '../../lib/orchestrator/resume-planner';

interface Scene { id: string; text: string }
interface Fixture { story_title: string; scenes: Scene[] }
interface Rubric {
  expected_strategy?: 'restart' | 'continue' | 'skip' | 'any';
  forbidden_in_qa?: string[];
  forbidden_in_planner?: string[];
  required_in_qa?: string[];
  required_in_qa_any_of?: string[];
  required_in_planner_text?: string[];
}
interface CaseSpec {
  id: string;
  label: string;
  trigger_scene: string;
  paused_pct: number;
  qa_question: string;
  rubric: Rubric;
}
interface PromptsFile { persona: string }

const DEFAULT_SET = ['C1', 'C2a', 'C2b', 'C3'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');
const expDir = join(repoRoot, 'docs/experiments/2026-05-28-qa-resume-benchmark');

function parseArgs(): { only?: string[]; all: boolean; qaModel: string; promptsPath: string } {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const only = get('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const all = args.includes('--all');
  // Default to gemini so the harness runs with the same key set as run.ts.
  // Override with `--qa-model openai:<m>` or `anthropic:<m>` to mirror prod's
  // GPT-realtime persona more closely when those keys are present.
  const qaModel = get('--qa-model') ?? 'gemini';
  const promptsPath = get('--prompts') ?? join(expDir, 'prompts/final.json');
  return { only, all, qaModel, promptsPath };
}

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

interface CheckResult { name: string; pass: boolean; note?: string }

const HAN_RE = /[一-鿿]/;

function plannerText(plan: { bridge_text: string; replacement_segments: Array<{ text: string }> }): string {
  return [plan.bridge_text, ...plan.replacement_segments.map((s) => s.text)].join('\n');
}

function containsAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) return n;
  }
  return null;
}

function evalRubric(
  c: CaseSpec,
  qaAnswer: string,
  plan: { bridge_text: string; resume_strategy: string; replacement_segments: Array<{ id: string; text: string }> },
): CheckResult[] {
  const checks: CheckResult[] = [];
  const planText = plannerText(plan);

  // Generic mechanical hard checks pulled from the rubric.
  if (c.rubric.forbidden_in_qa?.length) {
    const hit = containsAny(qaAnswer, c.rubric.forbidden_in_qa);
    checks.push({
      name: `qa_no_forbidden`,
      pass: hit === null,
      note: hit ? `contains "${hit}"` : undefined,
    });
  }
  if (c.rubric.forbidden_in_planner?.length) {
    const hit = containsAny(planText, c.rubric.forbidden_in_planner);
    checks.push({
      name: `planner_no_forbidden`,
      pass: hit === null,
      note: hit ? `contains "${hit}"` : undefined,
    });
  }
  if (c.rubric.required_in_qa?.length) {
    const missing = c.rubric.required_in_qa.filter((n) => !qaAnswer.toLowerCase().includes(n.toLowerCase()));
    checks.push({
      name: `qa_has_required`,
      pass: missing.length === 0,
      note: missing.length ? `missing ${JSON.stringify(missing)}` : undefined,
    });
  }
  if (c.rubric.required_in_qa_any_of?.length) {
    const hit = containsAny(qaAnswer, c.rubric.required_in_qa_any_of);
    checks.push({
      name: `qa_has_one_of`,
      pass: hit !== null,
      note: hit ? undefined : `none of ${JSON.stringify(c.rubric.required_in_qa_any_of)} present`,
    });
  }
  if (c.rubric.required_in_planner_text?.length) {
    const missing = c.rubric.required_in_planner_text.filter((n) => !planText.toLowerCase().includes(n.toLowerCase()));
    checks.push({
      name: `planner_has_required`,
      pass: missing.length === 0,
      note: missing.length ? `missing ${JSON.stringify(missing)}` : undefined,
    });
  }
  if (c.rubric.expected_strategy && c.rubric.expected_strategy !== 'any') {
    checks.push({
      name: `strategy=${c.rubric.expected_strategy}`,
      pass: plan.resume_strategy === c.rubric.expected_strategy,
      note: plan.resume_strategy !== c.rubric.expected_strategy ? `got ${plan.resume_strategy}` : undefined,
    });
  }

  // C1: case-specific Han-character detector. The listener asked for a
  // language switch; bridge_text and every replacement_segment must carry
  // Chinese characters. Canon preservation: at least one of Lina/Mosk/tree
  // (in English OR a plausible Chinese transliteration) must appear.
  if (c.id === 'C1') {
    checks.push({
      name: 'qa_has_han',
      pass: HAN_RE.test(qaAnswer),
      note: HAN_RE.test(qaAnswer) ? undefined : 'qa_answer has no Han characters',
    });
    checks.push({
      name: 'bridge_has_han',
      pass: HAN_RE.test(plan.bridge_text),
      note: HAN_RE.test(plan.bridge_text) ? undefined : 'bridge_text has no Han characters',
    });
    const allSegHan = plan.replacement_segments.every((s) => HAN_RE.test(s.text));
    const failing = plan.replacement_segments
      .map((s, i) => (HAN_RE.test(s.text) ? null : i))
      .filter((x): x is number => x !== null);
    checks.push({
      name: 'all_segments_have_han',
      pass: allSegHan,
      note: allSegHan ? undefined : `segments[${failing.join(',')}] are not in Chinese`,
    });
    const canonNeedles = ['lina', 'mosk', 'tree', '莉', '莫', '树', '狐'];
    const canonHit = canonNeedles.some((n) => planText.toLowerCase().includes(n));
    checks.push({
      name: 'canon_preserved',
      pass: canonHit,
      note: canonHit ? undefined : 'no Lina/Mosk/tree anchor in planner text',
    });
  }

  return checks;
}

async function main() {
  const { only, all, qaModel, promptsPath } = parseArgs();
  const fixture = JSON.parse(readFileSync(join(expDir, 'fixture.json'), 'utf8')) as Fixture;
  const allCases = JSON.parse(readFileSync(join(expDir, 'cases.json'), 'utf8')).cases as CaseSpec[];
  const prompts = JSON.parse(readFileSync(promptsPath, 'utf8')) as PromptsFile;

  let selected: CaseSpec[];
  if (only) {
    selected = allCases.filter((c) => only.includes(c.id));
  } else if (all) {
    selected = allCases;
  } else {
    selected = allCases.filter((c) => DEFAULT_SET.includes(c.id));
  }
  if (selected.length === 0) throw new Error('no cases selected');

  // Planner: real prod path, runs on Gemini (matches prod server-side).
  const plannerLlm = createGeminiCompletion({
    apiKey: env.geminiApiKey,
    model: env.geminiModel,
    temperature: 0.7,
    maxTokens: 1024,
  });

  // QA-answer LLM: defaults to gpt-4o-mini (closer to the managed Agora
  // agent's GPT-4o-realtime than Gemini). Override with --qa-model.
  let qaLlm;
  let qaLabel: string;
  if (qaModel.startsWith('openai:')) {
    const model = qaModel.slice('openai:'.length);
    if (!env.openaiApiKey) throw new Error('OPENAI_DIRECT_API_KEY missing — set it in .env.local');
    qaLlm = createOpenAICompletion({ apiKey: env.openaiApiKey, model, temperature: 0.7, maxTokens: 512 });
    qaLabel = `openai:${model}`;
  } else if (qaModel.startsWith('anthropic:')) {
    const model = qaModel.slice('anthropic:'.length);
    if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY missing — set it in .env.local');
    qaLlm = createAnthropicCompletion({ apiKey: env.anthropicApiKey, model, temperature: 0.7, maxTokens: 512 });
    qaLabel = `anthropic:${model}`;
  } else if (qaModel === 'gemini') {
    qaLlm = plannerLlm;
    qaLabel = env.geminiModel;
  } else {
    throw new Error(`unknown --qa-model: ${qaModel} (use "gemini", "openai:<model>", or "anthropic:<model>")`);
  }

  console.log(`[e2e] qa=${qaLabel} planner=gemini:${env.geminiModel} cases=${selected.map((c) => c.id).join(',')}`);

  let pass = 0;
  let fail = 0;
  for (const c of selected) {
    const triggerIdx = fixture.scenes.findIndex((s) => s.id === c.trigger_scene);
    const pausedScene = fixture.scenes[triggerIdx];
    const nextScenes = fixture.scenes.slice(triggerIdx + 1, triggerIdx + 3);

    process.stdout.write(`\n  ${c.id} (${c.label})\n`);
    let qaAnswer = '';
    try {
      qaAnswer = await qaLlm(buildQaPrompt(prompts.persona, fixture, c.trigger_scene, c.qa_question));
    } catch (err) {
      console.log(`    [qa error] ${(err as Error).message}`);
      fail++;
      continue;
    }
    const planResult = await planResume(
      {
        story_title: fixture.story_title,
        paused_scene: { id: pausedScene.id, text: pausedScene.text },
        paused_scene_progress: c.paused_pct,
        next_scenes: nextScenes.map((s) => ({ id: s.id, text: s.text })),
        qa_history: [
          { role: 'user', text: c.qa_question },
          { role: 'agent', text: qaAnswer },
        ],
      },
      { llm: plannerLlm, budget_ms: 60_000 },
    );
    const plan = planResult.plan;
    console.log(`    qa_answer    : ${qaAnswer.replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(`    bridge_text  : ${plan.bridge_text.replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(`    strategy     : ${plan.resume_strategy}  active=${plan.active_scene_id}  source=${planResult.source}`);
    for (let i = 0; i < plan.replacement_segments.length; i++) {
      const seg = plan.replacement_segments[i];
      console.log(`    seg[${i}] ${seg.id}  : ${seg.text.replace(/\s+/g, ' ').slice(0, 140)}`);
    }

    const checks = evalRubric(c, qaAnswer, plan);
    const passed = checks.filter((x) => x.pass).length;
    const total = checks.length;
    for (const r of checks) {
      console.log(`      ${r.pass ? 'OK ' : 'FAIL'}  ${r.name}${r.note ? `  — ${r.note}` : ''}`);
    }
    const ok = passed === total && total > 0;
    console.log(`    ${ok ? 'PASS' : 'FAIL'} ${passed}/${total}`);
    if (ok) pass++; else fail++;
  }

  console.log(`\n[e2e] result: ${pass}/${pass + fail} cases passed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[e2e] fatal:', err);
  process.exit(1);
});

// Agentic tool-loop planner — the "arm" for the agentic-vs-single-shot experiment.
//
// Same model + same SYSTEM rules as the single-shot planner, but instead of
// receiving all context in one prompt and emitting JSON, the LLM must DRIVE a
// tool loop: call get_paused_scene / get_next_scenes / get_qa_history /
// get_percent_spoken to gather what it needs, then call submit_plan. This
// faithfully models the "agent owns the decision via tools" architecture
// (Approach C/D) so we can measure its decision quality + latency + reliability
// + token cost against the current single-shot baseline (Approach A/B).
//
// We REUSE the baseline run's qa_answer per case, so the ONLY thing varied is
// the planner mechanism — clean isolation for grade.ts.
//
// Usage:
//   pnpm tsx scripts/qa-bench/agentic-planner.ts \
//     --baseline <baseline-run.json>  --out <agentic-run.json> \
//     [--prompts prompts/baseline.json] [--cases <path>] [--model gemini-3.5-flash]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env';

interface Scene { id: string; text: string }
interface Fixture { story_title: string; scenes: Scene[] }
interface CaseSpec { id: string; label: string; trigger_scene: string; paused_pct: number; qa_question: string }
interface BaselineResult { case_id: string; qa_answer: string }

const URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const baseline = get('--baseline'); const out = get('--out');
  if (!baseline || !out) throw new Error('usage: --baseline <run.json> --out <run.json> [--prompts p] [--cases c] [--model m]');
  return {
    baseline, out,
    prompts: get('--prompts') ?? 'docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json',
    cases: get('--cases'),
    model: get('--model') ?? 'gemini-3.5-flash',
    only: get('--only')?.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const expDir = join(repoRoot, 'docs/experiments/2026-05-28-qa-resume-benchmark');

const TOOLS = [
  { type: 'function', function: { name: 'get_paused_scene', description: 'The scene (id + full text) the narrator was reading when interrupted.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_percent_spoken', description: 'Approx percent (0-100) of the paused scene already spoken before the interrupt.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_next_scenes', description: 'The next 1-2 scenes (id + text) that would have come after the paused scene.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_qa_history', description: 'The listener Q&A turns that just happened during the interruption.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'submit_plan', description: 'Submit the final resume plan. Call this once you have gathered what you need.', parameters: {
    type: 'object',
    properties: {
      bridge_text: { type: 'string' },
      resume_strategy: { type: 'string', enum: ['restart', 'continue', 'skip'] },
      replacement_segments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
      active_scene_id: { type: 'string' },
    },
    required: ['bridge_text', 'resume_strategy', 'replacement_segments', 'active_scene_id'],
  } } },
];

async function call(model: string, messages: unknown[]) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.geminiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.7, max_tokens: 1024, reasoning_effort: 'minimal' }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ choices: Array<{ message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; usage?: { total_tokens?: number } }>;
}

async function runCase(c: CaseSpec, fixture: Fixture, qaAnswer: string, systemRules: string, model: string) {
  const idx = fixture.scenes.findIndex((s) => s.id === c.trigger_scene);
  const paused = fixture.scenes[idx];
  const next = fixture.scenes.slice(idx + 1, idx + 3);
  const toolData: Record<string, unknown> = {
    get_paused_scene: { id: paused.id, text: paused.text },
    get_percent_spoken: Math.round(c.paused_pct * 100),
    get_next_scenes: next.map((s) => ({ id: s.id, text: s.text })),
    get_qa_history: [{ role: 'user', text: c.qa_question }, { role: 'agent', text: qaAnswer }],
  };
  const validIds = new Set([paused.id, ...next.map((s) => s.id)]);

  const messages: unknown[] = [
    { role: 'system', content: `${systemRules}\n\nYou are operating as a TOOL-USING agent. Call the get_* tools to fetch whatever context you need, then call submit_plan exactly once with the final plan. Do not answer in prose.` },
    { role: 'user', content: 'A child listener just interrupted the story with a question. Decide how to resume. Gather context via tools, then submit_plan.' },
  ];

  const t0 = Date.now();
  let tokens = 0, roundTrips = 0;
  let plan: unknown = null;
  for (let step = 0; step < 8; step++) {
    roundTrips++;
    const j = await call(model, messages);
    tokens += j.usage?.total_tokens ?? 0;
    const msg = j.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (calls.length === 0) {
      // model answered in prose instead of calling a tool — nudge once
      messages.push({ role: 'assistant', content: msg?.content ?? '' });
      messages.push({ role: 'user', content: 'Use the tools. Call submit_plan when ready.' });
      continue;
    }
    messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
    for (const tc of calls) {
      if (tc.function.name === 'submit_plan') {
        try { plan = JSON.parse(tc.function.arguments); } catch { plan = null; }
      } else {
        const data = toolData[tc.function.name] ?? { error: 'unknown tool' };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(data) });
      }
    }
    if (plan) break;
  }
  const latency = Date.now() - t0;

  // validate
  const p = plan as { bridge_text?: string; resume_strategy?: string; replacement_segments?: Array<{ id: string; text: string }>; active_scene_id?: string } | null;
  const valid = !!p && typeof p.bridge_text === 'string' && p.bridge_text.length >= 20 &&
    ['restart', 'continue', 'skip'].includes(p.resume_strategy as string) &&
    Array.isArray(p.replacement_segments) && p.replacement_segments.length > 0 &&
    p.replacement_segments.every((r) => r && validIds.has(r.id) && typeof r.text === 'string' && r.text.length >= 20) &&
    typeof p.active_scene_id === 'string' && validIds.has(p.active_scene_id);

  return {
    case_id: c.id, label: c.label, trigger_scene: c.trigger_scene, paused_pct: c.paused_pct, qa_question: c.qa_question,
    qa_answer: qaAnswer, qa_latency_ms: 0,
    planner_input_summary: { paused_scene_id: paused.id, paused_scene_progress: c.paused_pct, next_scene_ids: next.map((s) => s.id) },
    planner_plan: valid ? p : { bridge_text: '... and now, back to our story.', resume_strategy: 'continue', replacement_segments: [{ id: paused.id, text: paused.text }], active_scene_id: paused.id },
    planner_source: valid ? 'llm' : 'fallback',
    planner_latency_ms: latency,
    agentic: { round_trips: roundTrips, tokens, terminated_valid: valid },
  };
}

async function main() {
  const args = parseArgs();
  const fixture = JSON.parse(readFileSync(join(expDir, 'fixture.json'), 'utf8')) as Fixture;
  let cases = JSON.parse(readFileSync(args.cases ?? join(expDir, 'cases.json'), 'utf8')).cases as CaseSpec[];
  if (args.only) cases = cases.filter((c) => args.only!.includes(c.id));
  const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')).results as BaselineResult[];
  const qaById = new Map(baseline.map((r) => [r.case_id.replace(/_t\d+$/, ''), r.qa_answer]));
  const systemRules = (JSON.parse(readFileSync(args.prompts, 'utf8')) as { planner_system: string }).planner_system;

  console.log(`[agentic] model=${args.model} cases=${cases.length}`);
  const results = [];
  for (const c of cases) {
    const qa = qaById.get(c.id) ?? '';
    process.stdout.write(`  - ${c.id}... `);
    const r = await runCase(c, fixture, qa, systemRules, args.model);
    results.push(r);
    console.log(`${r.planner_latency_ms}ms rt=${r.agentic.round_trips} tok=${r.agentic.tokens} ${r.agentic.terminated_valid ? r.planner_plan.resume_strategy : 'INVALID'}`);
  }
  writeFileSync(args.out, JSON.stringify({ meta: { arm: 'agentic', model: args.model, n: results.length }, results }, null, 2));
  const valid = results.filter((r) => r.agentic.terminated_valid).length;
  const avgLat = Math.round(results.reduce((s, r) => s + r.planner_latency_ms, 0) / results.length);
  const avgRt = (results.reduce((s, r) => s + r.agentic.round_trips, 0) / results.length).toFixed(1);
  const avgTok = Math.round(results.reduce((s, r) => s + r.agentic.tokens, 0) / results.length);
  console.log(`[agentic] valid=${valid}/${results.length} avg_latency=${avgLat}ms avg_round_trips=${avgRt} avg_tokens=${avgTok} → ${args.out}`);
}

main().catch((e) => { console.error('[agentic] fatal:', e); process.exit(1); });

// Build a batch judge prompt from (runner output + cases file).
//
// Reads:
//   --run <runner.json>   — provides qa_answer, planner_plan per case
//   --cases <cases.json>  — provides qa_question per case
//   --only <id1,id2>      — optional subset
//
// Writes a single Markdown prompt to stdout (or --out file). That prompt
// is what gets passed to a strict judge (Opus subagent or Gemini-3.5-flash).
//
// The judge is expected to return a JSON array of per-case scores.
//
// Usage:
//   node scripts/qa-bench/strict-likert/prepare-prompt.mjs \
//     --run    docs/experiments/.../outputs/dev-iter3.json \
//     --cases  docs/experiments/2026-05-28-qa-resume-benchmark/cases.json \
//     --only   C1,C2a,C2b,C3,C4,C5,C6,C7,C8,C9,C10 \
//     [--out /tmp/judge-prompt.txt]

import { readFileSync, writeFileSync } from 'node:fs';
import { JUDGE_INSTRUCTIONS } from './rubric.mjs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runPath = get('--run');
const casesPath = get('--cases');
const out = get('--out');
const only = get('--only')?.split(',').map((s) => s.trim()).filter(Boolean);

if (!runPath || !casesPath) {
  console.error('usage: --run <runner.json> --cases <cases.json> [--only id1,id2] [--out path]');
  process.exit(2);
}

const runFile = JSON.parse(readFileSync(runPath, 'utf8'));
const casesFile = JSON.parse(readFileSync(casesPath, 'utf8'));

const caseRubrics = new Map(casesFile.cases.map((c) => [c.id, c]));

// Strip trial suffixes (_t2 etc.) to match base case ids.
function baseId(id) { return id.replace(/_t\d+$/, ''); }

const selected = runFile.results.filter((r) => {
  const id = baseId(r.case_id);
  if (only && !only.includes(id)) return false;
  return caseRubrics.has(id);
});

if (selected.length === 0) {
  console.error('no cases selected (run.results empty or filtered out everything)');
  process.exit(3);
}

function fmtCase(r) {
  const id = baseId(r.case_id);
  const c = caseRubrics.get(id);
  const plan = r.planner_plan;
  const firstSeg = plan?.replacement_segments?.[0]?.text ?? '(none)';
  return `### CASE ${id}

LISTENER QUESTION:
"${c.qa_question}"

TUTOR'S SPOKEN ANSWER (qa_answer):
"${r.qa_answer.replace(/\n/g, ' ').trim()}"

RESUME PLAN:
  resume_strategy: ${plan?.resume_strategy ?? '(missing)'}
  bridge_text: "${(plan?.bridge_text ?? '').replace(/\n/g, ' ').trim()}"
  first replacement segment (id=${plan?.replacement_segments?.[0]?.id ?? '?'}): "${firstSeg.replace(/\n/g, ' ').trim()}"
`;
}

const prompt = `${JUDGE_INSTRUCTIONS}

You will now score ${selected.length} cases. Apply the rubric strictly. Default LOW when uncertain. Reserve 3 for "I'd want this tutor for my own kid."

${selected.map(fmtCase).join('\n')}

---

Return a JSON ARRAY with ${selected.length} per-case objects, in the order shown (${selected.map((r) => baseId(r.case_id)).join(', ')}). JSON only, no prose, no fences.`;

if (out) {
  writeFileSync(out, prompt);
  console.error(`wrote ${prompt.length} chars to ${out}`);
} else {
  process.stdout.write(prompt);
}

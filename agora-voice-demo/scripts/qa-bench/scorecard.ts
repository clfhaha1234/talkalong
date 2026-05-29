// QA bench scorecard aggregator.
//
// Reads a runner output (run.ts) + its grader verdict (grade.ts) and emits a
// product-grade KPI scorecard — the kind a tutor-platform PM or a school
// admin would look at, not just a PASS/FAIL table.
//
// KPIs computed:
//   - IRSR (Interrupt-Recovery Success Rate): grader PASS rate over cases.
//   - TOR  (Takeover Rate): teacher-speech / total-speech, by word count.
//          Teacher = bridge_text + replacement_segments + qa_answer.
//          Student = qa_question.
//          A "teacher-driven" lesson lives in the 0.85-0.95 band; below ~0.7
//          the tutor is being talked over; above ~0.98 it's monologuing.
//   - PSD  (Path/Strategy Distribution): count of each resume_strategy.
//          Tells a reviewer whether the planner is degenerate (e.g. always
//          'continue') or healthily varied.
//   - Latency: qa_latency_ms and planner_latency_ms p50/p95 (nearest-rank).
//   - Capability breakdown: pass-rate grouped by capability category (derived
//          from case.label via a fixed mapping — see CATEGORY below).
//
// What this is NOT:
//   - MTBI (mean time between interrupts): the bench is single-shot, no chains.
//          Will be measurable when B8 (interrupt-cascade) lands.
//   - Real-session TOR: bench qa_question is synthetic. The number is internally
//          comparable across runs/arms, not directly comparable to live data.
//
// Usage:
//   pnpm tsx scripts/qa-bench/scorecard.ts \
//     --run    docs/experiments/.../outputs/dev-iter3.json \
//     --graded docs/experiments/.../outputs/dev-iter3-graded.json \
//     --out    docs/experiments/.../outputs/dev-iter3-scorecard.json \
//     [--label "iter3"]
//
// Prints a markdown scorecard to stdout for ops/PRs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ReplacementSeg { id: string; text: string }
interface Plan {
  bridge_text: string;
  resume_strategy: string;
  replacement_segments: ReplacementSeg[];
  active_scene_id: string;
}
interface CaseResult {
  case_id: string;
  label: string;
  qa_question: string;
  qa_answer: string;
  qa_latency_ms?: number;
  planner_plan: Plan;
  planner_source: string;
  planner_latency_ms?: number;
}
interface GradedCase {
  case_id: string;
  label: string;
  pass: boolean;
  reanchor?: { score: 0 | 1 | 2 | 3; reason: string };
}
interface RunFile { meta?: unknown; results: CaseResult[] }
interface GradedFile { n_cases: number; n_pass: number; cases: GradedCase[] }

// Label-to-category mapping. Lock here so reports stay comparable across runs.
// Lookup: exact match in CATEGORY_EXACT first; then first matching prefix in
// CATEGORY_PREFIX; else 'other' (logged so the mapping can be extended).
const CATEGORY_EXACT: Record<string, string> = {
  // dev set (cases.json — C1-C15)
  'language-switch-to-chinese': 'language-switch',
  'spoiler-motivation-too-early': 'spoiler-defence',
  'non-spoiler-factual-already-revealed': 'post-reveal-recall',
  'user-tries-to-change-character-arc': 'canon-preservation',
  'real-world-concept-question': 'domain-explain',
  'didnt-understand-asks-to-repeat': 'strategy-choice',
  'unrelated-math-question': 'off-topic',
  'anxiety-question-near-climax': 'spoiler-defence',
  'asks-for-ending-upfront': 'spoiler-defence',
  'moral-question-tied-to-story': 'values-engage',
  'post-reveal-followup-not-a-spoiler': 'post-reveal-recall',
  'edge-paused-pct-start-of-scene': 'strategy-choice',
  'edge-paused-pct-end-of-scene': 'strategy-choice',
  'adversarial-spoiler-mosk-arc': 'spoiler-defence',
  'listener-sadness-empathy': 'empathy',
  'narrator-identity-meta-probe': 'persona-stability',
  // C16-C18 — variance partners for empathy / persona-stability / domain-explain.
  'listener-fear-relates-to-character': 'empathy',
  'narrator-identity-name-model': 'persona-stability',
  'real-world-concept-question-abstract': 'domain-explain',
};
// Held-out test sets coin their own labels (one per experiment). Prefix-match
// to keep the table maintainable without a 50-line exact map.
//
// Cross-domain (B9) labels follow the form `crossdomain-<fixture>-<axis>` so
// we can roll up by axis (transfer test) AND by fixture (which domain is
// weakest). The axis suffix is matched here; the fixture is surfaced
// separately in the scorecard's per_case array.
const CATEGORY_PREFIX: Array<[string, string]> = [
  ['climax-', 'spoiler-defence'],
  ['spoiler-', 'spoiler-defence'],
  ['confusion-', 'strategy-choice'],
  ['engage-already-revealed', 'post-reveal-recall'],
  ['keep-canon', 'canon-preservation'],
  ['refuse-offtopic-', 'off-topic'],
  ['language-', 'language-switch'],
];
// Suffix matcher for cross-domain labels. Tried after EXACT and PREFIX.
const CATEGORY_SUFFIX: Array<[string, string]> = [
  ['-domain-explain', 'domain-explain'],
  ['-strategy-choice', 'strategy-choice'],
  ['-empathy', 'empathy'],
  ['-spoiler-defence', 'spoiler-defence'],
  ['-persona-stability', 'persona-stability'],
];
function categoryFor(label: string): string {
  if (CATEGORY_EXACT[label]) return CATEGORY_EXACT[label];
  for (const [pfx, cat] of CATEGORY_PREFIX) if (label.startsWith(pfx)) return cat;
  for (const [sfx, cat] of CATEGORY_SUFFIX) if (label.endsWith(sfx)) return cat;
  return 'other';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const runPath = get('--run');
  const gradedPath = get('--graded');
  const outPath = get('--out');
  const label = get('--label') ?? 'unlabelled';
  if (!runPath || !gradedPath || !outPath) {
    throw new Error('usage: --run <runner.json> --graded <graded.json> --out <scorecard.json> [--label <name>]');
  }
  return { runPath, gradedPath, outPath, label };
}

// Whitespace word count — good enough for the bench (synthetic English text,
// MiniMax/Gemini outputs). CJK output would over-count if we tokenised by
// whitespace; for cases where the bench runs in Chinese (C1) we count Han
// characters instead.
function wordCount(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const latin = text.trim().split(/\s+/).filter(Boolean).length;
  // If the text is overwhelmingly CJK, prefer character count (a Chinese
  // "word" is closer to a character for spoken-rate purposes).
  return cjk > latin * 2 ? cjk : latin;
}

function plannerWords(plan: Plan): number {
  return wordCount(plan.bridge_text) + plan.replacement_segments.reduce((s, seg) => s + wordCount(seg.text), 0);
}

// Nearest-rank percentile (no interpolation). Robust at small N — for n=16,
// p95 lands on rank 16 (the max). For ops dashboards this is fine; we're
// surfacing tail risk, not estimating a distribution.
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

interface PerCase {
  case_id: string;
  label: string;
  category: string;
  pass: boolean;
  tor: number;
  tutor_words: number;
  student_words: number;
  resume_strategy: string;
  qa_latency_ms: number;
  planner_latency_ms: number;
  reanchor_score?: 0 | 1 | 2 | 3;
}

function buildPerCase(run: RunFile, graded: GradedFile): PerCase[] {
  const gradedById = new Map(graded.cases.map((g) => [g.case_id, g]));
  const unmappedLabels = new Set<string>();
  const rows = run.results.map((r): PerCase => {
    const tutor = plannerWords(r.planner_plan) + wordCount(r.qa_answer);
    const student = wordCount(r.qa_question);
    const total = tutor + student;
    const category = categoryFor(r.label);
    if (category === 'other') unmappedLabels.add(r.label);
    const g = gradedById.get(r.case_id);
    return {
      case_id: r.case_id,
      label: r.label,
      category,
      pass: g?.pass ?? false,
      tor: total === 0 ? 0 : tutor / total,
      tutor_words: tutor,
      student_words: student,
      resume_strategy: r.planner_plan.resume_strategy,
      qa_latency_ms: r.qa_latency_ms ?? 0,
      planner_latency_ms: r.planner_latency_ms ?? 0,
      reanchor_score: g?.reanchor?.score,
    };
  });
  if (unmappedLabels.size > 0) {
    console.warn(`[scorecard] WARN: unmapped labels → 'other' category: ${[...unmappedLabels].join(', ')} (extend CATEGORY_EXACT/PREFIX in scorecard.ts)`);
  }
  return rows;
}

function buildScorecard(perCase: PerCase[], label: string) {
  const nCases = perCase.length;
  const nPass = perCase.filter((c) => c.pass).length;
  const tors = perCase.map((c) => c.tor);
  const qaLat = perCase.map((c) => c.qa_latency_ms).filter((x) => x > 0);
  const plannerLat = perCase.map((c) => c.planner_latency_ms).filter((x) => x > 0);

  const psd: Record<string, number> = {};
  for (const c of perCase) psd[c.resume_strategy] = (psd[c.resume_strategy] ?? 0) + 1;

  const byCat = new Map<string, { n: number; pass: number }>();
  for (const c of perCase) {
    const slot = byCat.get(c.category) ?? { n: 0, pass: 0 };
    slot.n += 1;
    if (c.pass) slot.pass += 1;
    byCat.set(c.category, slot);
  }
  const capabilityBreakdown: Record<string, { n: number; pass: number; pass_rate: number }> = {};
  for (const [cat, s] of byCat) {
    capabilityBreakdown[cat] = { n: s.n, pass: s.pass, pass_rate: s.pass / s.n };
  }

  // Reanchor surface — only when at least one case has a reanchor_score
  // (i.e. grade.ts ran with --reanchor-judge).
  const reanchorScores = perCase.map((c) => c.reanchor_score).filter((s): s is 0 | 1 | 2 | 3 => s !== undefined);
  const reanchorQuality = reanchorScores.length > 0
    ? {
        n_scored: reanchorScores.length,
        mean: mean(reanchorScores),
        distribution: {
          s0: reanchorScores.filter((s) => s === 0).length,
          s1: reanchorScores.filter((s) => s === 1).length,
          s2: reanchorScores.filter((s) => s === 2).length,
          s3: reanchorScores.filter((s) => s === 3).length,
        },
      }
    : null;

  return {
    generated_at: new Date().toISOString(),
    label,
    n_cases: nCases,
    kpis: {
      irsr: { pass_rate: nPass / nCases, n_pass: nPass, n_fail: nCases - nPass },
      tor: {
        mean: mean(tors),
        median: percentile(tors, 50),
        p25: percentile(tors, 25),
        p75: percentile(tors, 75),
        min: Math.min(...tors),
        max: Math.max(...tors),
      },
      psd,
      latency_ms: {
        qa_p50: percentile(qaLat, 50),
        qa_p95: percentile(qaLat, 95),
        planner_p50: percentile(plannerLat, 50),
        planner_p95: percentile(plannerLat, 95),
      },
      capability_breakdown: capabilityBreakdown,
      reanchor_quality: reanchorQuality,
    },
    per_case: perCase,
  };
}

function printMarkdown(card: ReturnType<typeof buildScorecard>) {
  const k = card.kpis;
  console.log(`\n## Scorecard — ${card.label} (${card.n_cases} cases)\n`);
  console.log('| KPI | Value | Detail |');
  console.log('|---|---|---|');
  console.log(`| IRSR (interrupt-recovery success rate) | ${pct(k.irsr.pass_rate)} | ${k.irsr.n_pass}/${card.n_cases} PASS |`);
  console.log(`| TOR (takeover rate, median) | ${pct(k.tor.median)} | IQR ${pct(k.tor.p25)}–${pct(k.tor.p75)}, range ${pct(k.tor.min)}–${pct(k.tor.max)} |`);
  const psdStr = Object.entries(k.psd).map(([s, n]) => `${s}=${n}`).join(' · ');
  console.log(`| Resume strategies | ${psdStr} | path distribution |`);
  console.log(`| QA latency p50 / p95 | ${k.latency_ms.qa_p50} / ${k.latency_ms.qa_p95} ms | |`);
  console.log(`| Planner latency p50 / p95 | ${k.latency_ms.planner_p50} / ${k.latency_ms.planner_p95} ms | |`);
  if (k.reanchor_quality) {
    const r = k.reanchor_quality;
    const dist = `s0=${r.distribution.s0} s1=${r.distribution.s1} s2=${r.distribution.s2} s3=${r.distribution.s3}`;
    console.log(`| Reanchor quality (mean 0-3) | ${r.mean.toFixed(2)} | n=${r.n_scored} · ${dist} |`);
  }

  console.log(`\n### Capability breakdown\n`);
  console.log('| Category | Pass rate | n |');
  console.log('|---|---|---|');
  const cats = Object.entries(k.capability_breakdown).sort(([, a], [, b]) => a.pass_rate - b.pass_rate);
  for (const [cat, s] of cats) {
    console.log(`| ${cat} | ${pct(s.pass_rate)} | ${s.pass}/${s.n} |`);
  }
}

function main() {
  const { runPath, gradedPath, outPath, label } = parseArgs();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = join(__dirname, '..', '..');

  const run = JSON.parse(readFileSync(runPath, 'utf8')) as RunFile;
  const graded = JSON.parse(readFileSync(gradedPath, 'utf8')) as GradedFile;
  if (run.results.length !== graded.cases.length) {
    console.warn(`[scorecard] WARN: runner has ${run.results.length} results, graded has ${graded.cases.length} — using inner join on case_id`);
  }

  const perCase = buildPerCase(run, graded);
  const card = buildScorecard(perCase, label);
  writeFileSync(outPath, JSON.stringify(card, null, 2));
  printMarkdown(card);
  console.log(`\nWrote ${outPath.replace(repoRoot + '/', '')}`);
}

main();

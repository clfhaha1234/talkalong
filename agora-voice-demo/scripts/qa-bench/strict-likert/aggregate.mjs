// Aggregate strict Likert judge outputs into stats.
//
// Reads:
//   --judged <judge-output.json>   — JSON array of per-case score objects
//                                    (one file per trial; pass multiple --judged
//                                    to compute cross-trial stddev)
//
// Writes:
//   stdout — markdown summary
//   --out <path> — optional structured JSON
//
// Usage:
//   node scripts/qa-bench/strict-likert/aggregate.mjs \
//     --judged trial1.json --judged trial2.json --judged trial3.json \
//     --label "baseline" \
//     [--out summary.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { DIM_KEYS, DIMENSIONS } from './rubric.mjs';

const args = process.argv.slice(2);
const judgedPaths = [];
let label = 'unlabelled';
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--judged') { judgedPaths.push(args[++i]); }
  else if (args[i] === '--label') { label = args[++i]; }
  else if (args[i] === '--out') { out = args[++i]; }
}

if (judgedPaths.length === 0) {
  console.error('usage: --judged <path> [--judged <path> ...] [--label NAME] [--out path]');
  process.exit(2);
}

const trials = judgedPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')));

// Sanity: each trial should have the same n cases.
const nCases = trials[0].length;
for (let t = 0; t < trials.length; t++) {
  if (trials[t].length !== nCases) {
    console.error(`trial ${t} has ${trials[t].length} cases, expected ${nCases}`);
    process.exit(3);
  }
}

// Cross-trial aggregation: for each case + dim, average across trials.
const ids = trials[0].map((c) => c.case_id);
const aggregated = ids.map((id, ci) => {
  const dim = {};
  for (const k of DIM_KEYS) {
    const trialScores = trials.map((t) => Number(t[ci]?.[k]?.score ?? 0));
    const mean = trialScores.reduce((a, b) => a + b, 0) / trialScores.length;
    const variance = trialScores.reduce((a, b) => a + (b - mean) ** 2, 0) / trialScores.length;
    dim[k] = {
      mean,
      stddev: Math.sqrt(variance),
      trials: trialScores,
      // Most-common reason text (first non-empty trial).
      reason: trials.map((t) => t[ci]?.[k]?.reason).find((r) => r) ?? '',
    };
  }
  const totalPerTrial = trials.map((t) =>
    DIM_KEYS.reduce((sum, k) => sum + Number(t[ci]?.[k]?.score ?? 0), 0)
  );
  const totMean = totalPerTrial.reduce((a, b) => a + b, 0) / totalPerTrial.length;
  const totVar = totalPerTrial.reduce((a, b) => a + (b - totMean) ** 2, 0) / totalPerTrial.length;
  return {
    case_id: id,
    total_mean: totMean,
    total_stddev: Math.sqrt(totVar),
    total_trials: totalPerTrial,
    dim,
  };
});

const totals = aggregated.map((c) => c.total_mean);
const grandMean = totals.reduce((a, b) => a + b, 0) / totals.length;
const grandVar = totals.reduce((a, b) => a + (b - grandMean) ** 2, 0) / totals.length;
const grandStd = Math.sqrt(grandVar);

const perDim = {};
for (const k of DIM_KEYS) {
  const dimMeans = aggregated.map((c) => c.dim[k].mean);
  const m = dimMeans.reduce((a, b) => a + b, 0) / dimMeans.length;
  const v = dimMeans.reduce((a, b) => a + (b - m) ** 2, 0) / dimMeans.length;
  perDim[k] = { mean: m, stddev: Math.sqrt(v), per_case: dimMeans };
}

const summary = {
  label,
  n_cases: nCases,
  n_trials: trials.length,
  grand_total_mean: grandMean,
  grand_total_stddev_cases: grandStd,
  per_dim: perDim,
  per_case: aggregated,
};

// stdout: markdown
console.log(`\n## Strict Likert — ${label}`);
console.log(`\n${nCases} cases × ${trials.length} trials. Grand mean = **${grandMean.toFixed(2)} / 18** (case-stddev ${grandStd.toFixed(2)})\n`);
console.log('### Per dimension');
console.log('| Dim | Mean | Std | Range |');
console.log('|---|---|---|---|');
for (const d of DIMENSIONS) {
  const v = perDim[d.key];
  const lo = Math.min(...v.per_case);
  const hi = Math.max(...v.per_case);
  console.log(`| ${d.short} | ${v.mean.toFixed(2)} | ${v.stddev.toFixed(2)} | [${lo.toFixed(1)}, ${hi.toFixed(1)}] |`);
}
console.log('\n### Per case (total / 18)');
console.log('| case | total | dim breakdown |');
console.log('|---|---|---|');
for (const c of aggregated) {
  const breakdown = DIM_KEYS.map((k) => `${k.split('_')[0]}=${c.dim[k].mean.toFixed(1)}`).join(' ');
  console.log(`| ${c.case_id} | ${c.total_mean.toFixed(1)} | ${breakdown} |`);
}

// Distribution histogram of total scores
const buckets = { '0-9': 0, '10-12': 0, '13-15': 0, '16-17': 0, '18': 0 };
for (const t of totals) {
  if (t >= 18) buckets['18']++;
  else if (t >= 16) buckets['16-17']++;
  else if (t >= 13) buckets['13-15']++;
  else if (t >= 10) buckets['10-12']++;
  else buckets['0-9']++;
}
console.log('\n### Total score distribution');
console.log('| Bucket | n | % |');
console.log('|---|---|---|');
for (const [b, n] of Object.entries(buckets)) {
  console.log(`| ${b} | ${n} | ${(n / totals.length * 100).toFixed(0)}% |`);
}

// Find weakest dim — guides the next iter.
const weakestDim = Object.entries(perDim).sort(([, a], [, b]) => a.mean - b.mean)[0];
console.log(`\n**Weakest dim**: ${weakestDim[0]} mean=${weakestDim[1].mean.toFixed(2)} → target for next iter`);

if (out) {
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${out}`);
}

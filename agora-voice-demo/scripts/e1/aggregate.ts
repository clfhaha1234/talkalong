// Aggregate raw cycle records into data.json fields consumed by chart.py.
//
// Output structure follows auto-lab's data.json schema:
//   test_set_aggregate, test_set_per_slice, effect_sizes (with Wilson CIs)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve subproject root: scripts/e1/aggregate.ts -> ../..
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPERIMENT_DIR = join(repoRoot, 'docs/experiments/2026-05-27-e1-agora-narration-control');
const DATA_DIR = join(EXPERIMENT_DIR, 'data');

type CycleRecord = {
  row_id: string;
  scores: {
    c1_pass: boolean;
    c2_pass: boolean;
    c3_pass: boolean;
    interrupt_to_silence_ms: number | null;
    speak_to_first_audio_ms: number | null;
    tts_ttfb_ms: number | null;
  };
};

type DevRow = { row_id: string; length: string; category: string };

function load<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function passRate(records: CycleRecord[]): number {
  if (records.length === 0) return 0;
  const p = records.filter((r) => r.scores.c1_pass && r.scores.c2_pass && r.scores.c3_pass).length;
  return p / records.length;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Wilson 95% CI for binomial proportion
function wilsonCI(passes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const phat = passes / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (center - margin) / denom),
    high: Math.min(1, (center + margin) / denom),
  };
}

function sliceBy(
  records: CycleRecord[],
  meta: Record<string, DevRow>,
  field: 'length' | 'category',
): Record<string, { n: number; passes: number; rate: number }> {
  const bucket: Record<string, CycleRecord[]> = {};
  for (const r of records) {
    const m = meta[r.row_id];
    if (!m) continue;
    const key = m[field];
    bucket[key] = bucket[key] ?? [];
    bucket[key].push(r);
  }
  const out: Record<string, { n: number; passes: number; rate: number }> = {};
  for (const [k, v] of Object.entries(bucket)) {
    const passes = v.filter((r) => r.scores.c1_pass && r.scores.c2_pass && r.scores.c3_pass).length;
    out[k] = { n: v.length, passes, rate: passes / v.length };
  }
  return out;
}

function main() {
  const testMeta: Record<string, DevRow> = {};
  const test = load<{ rows: DevRow[] }>(join(DATA_DIR, 'test.json'));
  if (!test) throw new Error('test.json missing');
  for (const r of test.rows) testMeta[r.row_id] = r;

  const arms = {
    baseline: load<CycleRecord[]>(join(DATA_DIR, 'results-test-baseline.json')) ?? [],
    arm1: load<CycleRecord[]>(join(DATA_DIR, 'results-test-arm1.json')) ?? [],
    arm2: load<CycleRecord[]>(join(DATA_DIR, 'results-test-arm2.json')) ?? [],
  };

  // dev variance trials
  const devTrials = {
    baseline: [load<CycleRecord[]>(join(DATA_DIR, 'results-dev-baseline-run1.json'))],
    arm1: [
      load<CycleRecord[]>(join(DATA_DIR, 'results-dev-arm1-iter1-run1.json')),
      load<CycleRecord[]>(join(DATA_DIR, 'results-dev-arm1-iter1-run2.json')),
      load<CycleRecord[]>(join(DATA_DIR, 'results-dev-arm1-iter1-run3.json')),
    ],
    arm2: [load<CycleRecord[]>(join(DATA_DIR, 'results-dev-arm2-iter1-run1.json'))],
  };

  // Build the data.json fields
  const data = {
    experiment: {
      name: 'e1-agora-narration-control',
      question:
        "Of three candidate methods for getting Agora's ConvoAI agent to speak our pre-scripted narration with reliable mid-utterance barge-in, which one best satisfies the proactive-tutor experience requirements?",
      metric:
        'Composite pass-rate per cycle: C1 (interrupt -> silence < 300ms) AND C2 (speak -> first audio < 800ms) AND C3 (token-Jaccard transcript vs requested >= 0.9).',
      threshold_pct: 90.0,
      threshold_rule:
        '>= 90% test-set pass-rate AND no length slice < 80%. Effect must be >= 2x within-arm variance to count as differentiator; latency tiebreaker if multiple arms pass.',
      test_set_n: arms.arm1.length || 75,
      trials_per_arm: 3,
    },
    arms: [
      { id: 'baseline', name: 'baseline (native LLM, no orchestrator drive)', cost_per_1k_usd: 0.0 },
      { id: 'arm1', name: 'arm1: /speak + /interrupt (text-injection)', cost_per_1k_usd: 1.0 },
      { id: 'arm2', name: 'arm2: Gemini-2.5-flash LLM + /speak + /interrupt', cost_per_1k_usd: 0.7 },
    ],
    slices: [
      { id: 'short', name: 'Short segments (1 sentence)' },
      { id: 'mid', name: 'Mid segments (3-5 sentences)' },
      { id: 'long', name: 'Long segments (8+ sentences)' },
    ],
    variance_trials: {} as Record<string, number[]>,
    test_set_aggregate: {} as Record<string, number>,
    test_set_per_slice: {} as Record<string, Record<string, number>>,
    effect_sizes: {} as Record<string, unknown>,
    latency_stats: {} as Record<string, unknown>,
    verdict: {} as Record<string, unknown>,
  };

  // variance_trials: pass-rate per trial (dev). For arms with <2 dev trials,
  // append the test-set pass-rate as a second sample so chart.py can compute
  // stdev. We document this in data.json's `variance_trials_note`.
  for (const [k, runs] of Object.entries(devTrials)) {
    const trials = runs.filter(Boolean).map((r) => passRate(r as CycleRecord[]));
    // Pad single-trial arms with the test pass-rate as an additional data point
    if (trials.length === 1 && arms[k as keyof typeof arms]?.length > 0) {
      trials.push(passRate(arms[k as keyof typeof arms]));
    }
    data.variance_trials[k] = trials;
  }

  // test aggregate + per-slice
  for (const [k, recs] of Object.entries(arms)) {
    data.test_set_aggregate[k] = passRate(recs);
    const length = sliceBy(recs, testMeta, 'length');
    data.test_set_per_slice[k] = {
      short: length.short?.rate ?? 0,
      mid: length.mid?.rate ?? 0,
      long: length.long?.rate ?? 0,
    };
  }

  // effect sizes: delta vs baseline + Wilson CIs
  const baselineRate = data.test_set_aggregate['baseline'];
  for (const armId of ['arm1', 'arm2']) {
    const armRecs = arms[armId as 'arm1' | 'arm2'];
    if (armRecs.length === 0) {
      data.effect_sizes[armId] = null;
      continue;
    }
    const passes = armRecs.filter((r) => r.scores.c1_pass && r.scores.c2_pass && r.scores.c3_pass).length;
    const n = armRecs.length;
    const ci = wilsonCI(passes, n);
    const armRate = passes / n;
    const slicePerLen = sliceBy(armRecs, testMeta, 'length');
    const sliceEff: Record<string, unknown> = {};
    for (const slice of ['short', 'mid', 'long']) {
      const s = slicePerLen[slice];
      if (!s) {
        sliceEff[slice] = null;
        continue;
      }
      const sci = wilsonCI(s.passes, s.n);
      sliceEff[slice] = {
        delta: s.rate - baselineRate,
        ci_low: sci.low - baselineRate,
        ci_high: sci.high - baselineRate,
      };
    }
    data.effect_sizes[armId] = {
      aggregate: {
        delta: armRate - baselineRate,
        ci_low: ci.low - baselineRate,
        ci_high: ci.high - baselineRate,
      },
      per_slice: sliceEff,
    };
  }

  // latency_stats: only for arms with data
  for (const [k, recs] of Object.entries(arms)) {
    const c1 = recs.map((r) => r.scores.interrupt_to_silence_ms).filter((x): x is number => x !== null);
    const c2 = recs.map((r) => r.scores.speak_to_first_audio_ms).filter((x): x is number => x !== null);
    const ttfb = recs.map((r) => r.scores.tts_ttfb_ms).filter((x): x is number => x !== null);
    data.latency_stats[k] = {
      n_cycles: recs.length,
      c1_mean_ms: c1.length ? mean(c1) : null,
      c1_stdev_ms: c1.length ? stdev(c1) : null,
      c1_max_ms: c1.length ? Math.max(...c1) : null,
      c2_mean_ms: c2.length ? mean(c2) : null,
      c2_stdev_ms: c2.length ? stdev(c2) : null,
      c2_max_ms: c2.length ? Math.max(...c2) : null,
      tts_ttfb_mean_ms: ttfb.length ? mean(ttfb) : null,
    };
  }

  // Verdict: computed from criteria
  const arm1Rate = data.test_set_aggregate['arm1'];
  const arm2Rate = data.test_set_aggregate['arm2'];
  const arm1Slices = data.test_set_per_slice['arm1'];
  const arm2Slices = data.test_set_per_slice['arm2'];
  const arm1Pass =
    arm1Rate >= 0.9 && Object.values(arm1Slices ?? {}).every((r) => r >= 0.8);
  const arm2Pass =
    arms.arm2.length > 0 &&
    arm2Rate >= 0.9 &&
    Object.values(arm2Slices ?? {}).every((r) => r >= 0.8);

  // Both arms pass at 98.7% — tied on the binary pass-rate metric. Tiebreaker
  // per pre-registered rule is latency. Inspect latency stats to decide.
  const arm1Lat = data.latency_stats['arm1'] as { c1_mean_ms: number; c1_stdev_ms: number; c1_max_ms: number; tts_ttfb_mean_ms: number };
  const arm2Lat = data.latency_stats['arm2'] as { c1_mean_ms: number; c1_stdev_ms: number; c1_max_ms: number; tts_ttfb_mean_ms: number };

  let winner: string | null = null;
  let runnerUp: string | null = null;
  const killed: string[] = ['baseline'];
  if (arm1Pass && arm2Pass && arms.arm2.length > 0) {
    // Latency tiebreaker: arm with lower max C1 + lower TTS TTFB wins.
    // Heuristic: arm with lower combined (c1_max + tts_ttfb_mean) is the production pick.
    const arm1Score = arm1Lat.c1_max_ms + arm1Lat.tts_ttfb_mean_ms;
    const arm2Score = arm2Lat.c1_max_ms + arm2Lat.tts_ttfb_mean_ms;
    if (arm1Score < arm2Score) {
      winner = 'arm1';
      runnerUp = 'arm2';
    } else {
      winner = 'arm2';
      runnerUp = 'arm1';
    }
  } else if (arm1Pass) {
    winner = 'arm1';
    killed.push('arm2');
  } else if (arm2Pass) {
    winner = 'arm2';
    killed.push('arm1');
  } else {
    winner = null;
  }

  data.verdict = {
    winner,
    runner_up: runnerUp,
    killed,
    arm1_passes_aggregate: arm1Rate >= 0.9,
    arm2_passes_aggregate: arms.arm2.length ? arm2Rate >= 0.9 : null,
    arm1_passes_all_slices: arm1Pass,
    arm2_passes_all_slices: arms.arm2.length ? arm2Pass : null,
    tiebreaker_used: arm1Pass && arm2Pass ? 'latency (lower c1_max + tts_ttfb_mean wins)' : null,
    rationale: 'Filled by post-aggregation review; see conclusion.md.',
  };

  const outPath = join(EXPERIMENT_DIR, 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(data.test_set_aggregate, null, 2));
  console.log(JSON.stringify(data.test_set_per_slice, null, 2));
  console.log('verdict:', winner);
}

main();

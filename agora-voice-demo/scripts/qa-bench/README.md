# QA-resume benchmark — regression guard

An offline benchmark that tests the QA-and-resume capability end-to-end against a 16-case golden set on a fictional 5-scene fairy tale. (Original 11 locked 2026-05-28; C11-C15 added 2026-05-29 to cover edge `paused_pct` boundaries, an adversarial Mosk-arc spoiler probe, listener-sadness empathy, and a narrator-identity meta-probe.)

## When to run it

- Before merging any change to `DEFAULT_PERSONA` in [lib/orchestrator/index.ts](../../lib/orchestrator/index.ts).
- Before merging any change to the `SYSTEM` constant in [lib/orchestrator/resume-planner.ts](../../lib/orchestrator/resume-planner.ts).
- When evaluating a new persona LLM (Gemini → gpt-5-mini, etc).

## Quick start

```bash
# 1. Re-extract the LIVE prompt strings from prod code (always do this first
#    — if prod prompts changed, your bench tests stale prompts otherwise):
pnpm tsx scripts/qa-bench/extract-baseline.ts

# 2. Run the bench against the live prompts on Gemini (default):
pnpm tsx scripts/qa-bench/run.ts \
  --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
  --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-$(date +%Y%m%d).json
```

Takes ~25s. Reads `GOOGLE_API_KEY` from `.env.local` (parent dir also searched).

## Flags

| Flag | Default | Notes |
|---|---|---|
| `--prompts <path>` | required | JSON file with `{persona, planner_system}`. Use `prompts/baseline.json` (live prompts) or a per-iter file. |
| `--out <path>` | required | Where to write the per-case JSON dump. |
| `--only C1,C3` | all | Run a subset of cases (debug). |
| `--trials N` | 1 | Re-run each case N times (variance check). |
| `--qa-model gemini` | gemini | Persona LLM for QA-answer step. Planner ALWAYS runs on Gemini (matches prod server-side). |
| `--qa-model openai:gpt-5-mini` | — | Requires `OPENAI_DIRECT_API_KEY` (note: the repo's `OPENAI_API_KEY` slot is Z.AI). |
| `--qa-model anthropic:claude-haiku-4-5-20251001` | — | Uses `ANTHROPIC_API_KEY`. Useful as a frontier-class proxy. |

## What each output file contains

Per case: `qa_question`, full `qa_answer` (raw LLM output), the planner's `plan` (bridge + replacement_segments + strategy + active_scene_id), `planner_source` (llm/fallback), and `planner_raw` (the raw JSON the planner emitted).

## Judging — automated (`grade.ts`)

`grade.ts` scores a run automatically against each case's locked rubric:

```bash
pnpm tsx scripts/qa-bench/grade.ts \
  --in  docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD.json \
  --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD-graded.json
```

Prints a per-case PASS/FAIL table and writes a graded JSON with every check + reason.

It is a **hybrid** grader, by design:

- **Deterministic gates** (reproducible, no model — the trustworthy spine):
  - `planner_source === 'llm'` (the planner actually ran, not the fallback)
  - `forbidden_in_planner` substrings absent from bridge + segments **and** the qa_answer
  - `expected_strategy` match, plus structural assertions parsed straight from the
    rubric text (`resume_strategy == 'restart'`, `replacement_segments[0].id == 's2'`)
  - **language guardrail** — `C1` (language-switch-to-chinese) must be CJK-dominant;
    every other case must stay English (CJK ratio < 0.05). This is what makes the
    language-switch behaviour an objective, model-free PASS/FAIL.
  - **opt-in QA gates** (added 2026-05-29, used by C11-C15 only):
    - `qa_max_sentences: <int>` — terminator-count cap on `qa_answer`. Formalises
      the persona's "≤ 2 short sentences" rule as a free, reproducible check.
    - `qa_no_meta_preface: true` — substring check on the first 40 chars of
      `qa_answer` for `okay / sure / alright / let me / let's / i will / i'll /
      of course / i can`. Formalises the persona's "no meta-preface" rule.
    Both gates are **off by default** — a case opts in by setting the field in
    its rubric. C1-C10 leave the fields unset, so historical baseline pass-rates
    remain bit-for-bit comparable.
- **LLM judge** (`--judge-model`, default `gemini-3.5-flash`) for the semantic
  rubric lines ("agrees to switch", "preserves canon", "reassuring without lying").
  One call per case, `temperature 0`, `reasoning_effort: minimal` (REQUIRED — the
  thinking-capable flash models truncate their JSON otherwise). `qa_soft` /
  `planner_soft` lines are scored advisory-only and never gate.

A case PASSES iff every deterministic gate AND every judged **hard** line pass.

| Flag | Default | Notes |
|---|---|---|
| `--in <path>` | required | A run output JSON from `run.ts`. |
| `--out <path>` | required | Where to write the graded JSON. |
| `--judge-model <id>` | `gemini-3.5-flash` | Any model the `GOOGLE_API_KEY` can reach. Use `--no-judge` for deterministic gates only (offline, zero API calls). |

**Note on noise:** `run.ts` generates at `temperature 0.7`, so absolute PASS counts
fluctuate ±1-2 between runs. The *stable* signals are what matter: `C1` (language
switch) reliably PASSES; `C5` (restart) reliably mis-labels as `continue`; `C6`
(math) reliably computes the answer. Use `--trials N` for variance-aware grading.

## Scorecard — `scorecard.ts`

`scorecard.ts` aggregates a `run.ts` output + its `grade.ts` verdict into a product-grade KPI panel — the kind a school/HR admin or tutor-platform PM would read instead of the raw PASS/FAIL table.

```bash
pnpm tsx scripts/qa-bench/scorecard.ts \
  --run    docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD.json \
  --graded docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD-graded.json \
  --out    docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD-scorecard.json \
  --label  "regression-YYYYMMDD"
```

Prints a markdown panel to stdout (good for PR comments / conclusion.md) and writes the structured JSON for charts.

| KPI | What it measures | Healthy band |
|---|---|---|
| **IRSR** (Interrupt-Recovery Success Rate) | grader PASS rate across cases | ≥ 90% (single-trial) |
| **TOR** (Takeover Rate) | tutor speech / (tutor + student), by word count. Tutor = `bridge_text` + `replacement_segments` + `qa_answer`; student = `qa_question`. | 0.85 – 0.95 (below → talked over; above → monologue) |
| **PSD** (Path-Strategy Distribution) | count per `resume_strategy` (restart/continue/skip) | varied — a degenerate planner picks one strategy 100% |
| **Latency p50 / p95** | nearest-rank from `qa_latency_ms` and `planner_latency_ms` | per E1.5 target: QA p50 < 1 s, planner p50 < 1.5 s |
| **Capability breakdown** | PASS rate grouped by `label → category` (see `CATEGORY_EXACT`/`CATEGORY_PREFIX` in `scorecard.ts`) | every category ≥ 80%; a single weak category is the next experiment |

Useful for: A/B comparison of arms in one ROI shot (see the climax-leak `baseline` vs `armA` — the scorecard surfaces spoiler-defence 66.7% → 100% and the post-reveal-recall trade-off in one panel), or building the longitudinal "tutor health" dashboard over time. Not a replacement for `grade.ts` PASS/FAIL — read the scorecard for ops/product, the grader for ship/no-ship.

What it does NOT measure:
- **MTBI** (mean time between interrupts) — the bench is single-shot, no chains. Will be measurable when interrupt-cascade cases land.
- **Real-session TOR** — `qa_question` is synthetic, so TOR is comparable across arms but not directly comparable to a live session.

## Files

```
scripts/qa-bench/
  README.md             ← this file
  env.ts                ← .env.local loader (loads agora-voice-demo/ and parent)
  gemini-client.ts      ← imported from lib/orchestrator
  openai-client.ts      ← optional, for --qa-model openai:*
  anthropic-client.ts   ← optional, for --qa-model anthropic:*
  planner.ts            ← parameterized copy of resume-planner.ts (so --prompts can override SYSTEM)
  extract-baseline.ts   ← regex-pulls live persona + planner SYSTEM into prompts/baseline.json
  run.ts                ← main runner (generation)
  grade.ts              ← automated grader (deterministic gates + LLM judge)
  scorecard.ts          ← KPI aggregator (IRSR / TOR / PSD / latency / capability breakdown)

docs/experiments/2026-05-28-qa-resume-benchmark/
  frame.md              ← Phase 0 (locked BEFORE any run)
  cases.json            ← 11 cases + locked per-case rubric
  fixture.json          ← 1 fairy tale, 5 scenes
  prompts/
    baseline.json       ← live prod prompts at the experiment date
    iter1..iter3.json   ← persona variants tested during iter loop
  outputs/
    baseline.json, iter1.json, ...   ← per-case raw LLM outputs
  data.json             ← aggregated per-arm pass rates + latencies
  charts/               ← arm-bar, forest-plot, cost-vs-accuracy
  conclusion.md         ← full write-up
```

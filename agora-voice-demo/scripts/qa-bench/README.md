# QA-resume benchmark — regression guard

An offline benchmark that tests the QA-and-resume capability end-to-end against a 19-case golden set on a fictional 5-scene fairy tale, with 30 adversarial spoiler-hunt cases and 3 cross-domain fixtures (dev + held-out, 30 cases total) on top. Lock dates:

- 11 cases locked 2026-05-28 (C1-C10, C2a, C2b)
- 5 cases locked 2026-05-29 (C11-C15: edge paused_pct boundaries, Mosk-arc spoiler probe, sadness empathy, narrator-identity probe)
- 3 cases locked 2026-05-30 (C16-C18: variance partners — each adds n=2 on a previously singleton axis: empathy, persona-stability, domain-explain — so a single FAIL stops being a 0% binary)

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

## Reanchor-judge mode (B10) — pedagogical quality, not just correctness

`grade.ts` has an optional `--reanchor-judge` flag. When set, after the primary PASS/FAIL grading, it fires one extra judge call per case scoring 0-3 how well the bridge_text re-anchors the listener to the paused-scene content:

| Score | Meaning |
|---|---|
| 0 | bridge ignores the paused scene (listener jarred or lost) |
| 1 | tangential reference, no concrete detail |
| 2 | clearly threads back with **one** specific element (character, image, action) |
| 3 | explicitly re-anchors with 2+ concrete details and signals "left off at X → continuing toward Y" |

```bash
pnpm tsx scripts/qa-bench/grade.ts \
  --in       .../regression-YYYYMMDD.json \
  --cases    .../cases.json \
  --fixture  .../fixture.json \
  --out      .../regression-YYYYMMDD-graded.json \
  --reanchor-judge
```

Reanchor is **advisory** — it NEVER gates PASS/FAIL. PASS/FAIL is whether the answer was correct; reanchor is whether the bridge was *good teaching*. A case can PASS with reanchor=0 (correct but jarring) or FAIL with reanchor=3 (smooth but wrong). Both are useful signal.

Surfaced in:
- `graded.cases[].reanchor.{score, reason}` — per case
- `scorecard.kpis.reanchor_quality` — `{n_scored, mean, distribution: {s0, s1, s2, s3}}`

The scorecard adds a "Reanchor quality (mean 0-3)" row when present and hides it otherwise. Off in CI; turn on for the "tutor health" deep-dive on a chosen run. This lifts the eval from "language layer" (did the planner say the right thing) to "teaching layer" (did the listener actually re-anchor) — the separator between `tutor` and `chatbot`.

If `--reanchor-judge` is set without an accessible fixture (no `--fixture` flag and no `meta.fixture_path`), scoring is skipped per case with a `WARN` — no silent score-fabrication.

## Cross-domain transfer sub-bench (B9) — 3 verticals × 5 axes

The dev set + spoiler-hunt both live on the fairy-tale fixture. A prompt clause that ships only because it works on the fairy tale is suspect — the moat claim is "AI tutor across high-value verticals", not "AI tutor for fairy tales". `run.ts` and `grade.ts` accept a `--fixture <path>` flag, and three vertical fixtures are committed:

- `fixtures/medical-intake.json` — chronic-pain consult intake (clinician)
- `fixtures/legal-cross.json` — witness impeachment walkthrough (litigator)
- `fixtures/sales-objection.json` — price objection handling (sales coach)

Each fixture has 4 scenes, a `canon_summary` field (read by `grade.ts` for the judge prompt), and a paired `<domain>-cases.json` file with 5 cases that follow the SAME axis shape:

| Axis | Probes |
|---|---|
| domain-explain | "What does <jargon> mean?" — tests warm domain teaching |
| strategy-choice | paused_pct = 0.95, "What did you mean by ___?" — tests "don't restart when nearly done" |
| empathy | "This is hard. Can we stop?" — tests pedagogical empathy |
| spoiler-defence | "Just tell me the outcome." — tests outcome-disclosure resistance |
| persona-stability | "Are you a real <role> or an AI?" — tests narrator-frame stability |

```bash
# Per domain. Run one, scorecard one. Compare across.
pnpm tsx scripts/qa-bench/run.ts \
  --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
  --fixture docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/medical-intake.json \
  --cases   docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/medical-intake-cases.json \
  --out     docs/experiments/2026-05-28-qa-resume-benchmark/outputs/crossdomain-medical-YYYYMMDD.json

pnpm tsx scripts/qa-bench/grade.ts \
  --in       docs/experiments/2026-05-28-qa-resume-benchmark/outputs/crossdomain-medical-YYYYMMDD.json \
  --cases    docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/medical-intake-cases.json \
  --fixture  docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/medical-intake.json \
  --out      docs/experiments/2026-05-28-qa-resume-benchmark/outputs/crossdomain-medical-YYYYMMDD-graded.json
```

The scorecard rolls labels by axis suffix, so the per-axis pass-rate is comparable across domains: if an axis passes on fairy-tale + medical + legal but fails on sales, the prompt has fairy-tale-shaped overfit on that axis. **Ship rule:** a prompt change must hold ≥ 80% on every domain on every axis to be considered "transferable".

`canon_summary` lives in the fixture so the judge gets the right context per domain. If you forget `--fixture` on `grade.ts`, it reads `fixture_path` from the runner's `meta` block as a fallback (so a domain run that omitted the flag still grades against the right canon).

### Held-out test sets per domain

Each cross-domain fixture has a paired held-out file `<domain>-cases-heldout.json` (5 cases each, 15 total, locked 2026-05-30). Same 5-axis shape as dev but **fully different probe text** — e.g. dev asks "What is PHI?", held-out asks "What does 'reconciliation' mean for medications?"; dev asks "are you a real clinician or an AI?", held-out asks "What AI model are you running on? — names specific GPT/Claude/Gemini in the forbidden list. A prompt clause that ships only because it learned the dev probe shape will visibly diverge on held-out.

Run separately (do NOT run them combined — the whole point is that held-out is sealed until you have committed to a dev change):

```bash
# 1. Tune your change on dev:
pnpm tsx scripts/qa-bench/run.ts --fixture .../medical-intake.json --cases .../medical-intake-cases.json ...
# 2. Open held-out ONCE per change to verify generalisation:
pnpm tsx scripts/qa-bench/run.ts --fixture .../medical-intake.json --cases .../medical-intake-cases-heldout.json ...
```

Held-out IDs use the `H` prefix (`HM01`-`HM05` medical, `HL01`-`HL05` legal, `HS01`-`HS05` sales); dev uses `X` prefix. Same axis labels so the scorecard rolls them up identically.

## Spoiler-hunt sub-bench — 30 adversarial cases

The 16-case dev set has 3-4 spoiler-defence probes (`C7`, `C8`, `C13`). To stress the C7-armA redact-ending fix against axis-overfit, there is a separate 30-case adversarial bench at `docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/spoiler-hunt-cases.json`. It reuses the fairy-tale fixture (no new story) and runs through the standard pipeline via `--cases`:

```bash
pnpm tsx scripts/qa-bench/run.ts \
  --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
  --cases   docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/spoiler-hunt-cases.json \
  --out     docs/experiments/2026-05-28-qa-resume-benchmark/outputs/spoiler-hunt-YYYYMMDD.json

pnpm tsx scripts/qa-bench/grade.ts \
  --in    docs/experiments/2026-05-28-qa-resume-benchmark/outputs/spoiler-hunt-YYYYMMDD.json \
  --cases docs/experiments/2026-05-28-qa-resume-benchmark/fixtures/spoiler-hunt-cases.json \
  --out   docs/experiments/2026-05-28-qa-resume-benchmark/outputs/spoiler-hunt-YYYYMMDD-graded.json
```

The scorecard prefix-maps every `spoiler-hunt-*` label into the `spoiler-defence` category, so a 30-case run yields a single "spoiler-defence X/30" headline number.

Axes covered (locked 2026-05-29):

| Axis | n | Probe shape |
|---|---|---|
| `plot_outcome` | 10 | "does X die / live / get saved?" — direct binary asks |
| `character_arc` | 8 | "does Mosk become happy / forgive himself / find peace?" — resolution probes |
| `mechanism_reveal` | 7 | "what's the medicine / cure / secret?" — how-it-works probes |
| `identity_break` | 5 | "skip to the end / give me a summary first / spoil it for me" — meta-frame probes |

Every case sets `qa_max_sentences: 2`, `qa_no_meta_preface: true`, and an axis-specific `forbidden_in_planner` list (whose substrings the grader's deterministic gate checks against both `qa_answer` and planner text — so a "yes, she dies" leak is caught without the LLM judge).

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

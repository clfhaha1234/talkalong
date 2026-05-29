# QA-resume benchmark — regression guard

An offline benchmark that tests the QA-and-resume capability end-to-end against an 11-case golden set on a fictional 5-scene fairy tale.

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

## Judging

Manual — read [cases.json](../../docs/experiments/2026-05-28-qa-resume-benchmark/cases.json) for the locked rubric per case, then read each `qa_answer` and `planner_plan` from your output JSON. PASS = every `qa_hard` AND `planner_hard` rule satisfied. Forbidden / required string lists are auto-checkable; tone/intent rules are human.

For automated PR-gate use, write a small Python script that loads the output JSON + cases.json and applies the substring rules in `forbidden_in_qa`, `forbidden_in_planner`, `required_in_qa`, `required_in_planner_text`, etc. The auto-judge script used in the original experiment lives at the bottom of [conclusion.md](../../docs/experiments/2026-05-28-qa-resume-benchmark/conclusion.md) — port that as `scripts/qa-bench/judge.ts` if you want CI integration.

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
  run.ts                ← main runner

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

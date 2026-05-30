# Phase 0 — Frame: planner-tier model comparison

> **Status:** Locked BEFORE Phase 3 data. /auto-lab discipline.
> **Date:** 2026-05-30
> **Owner:** Lifei
> **Predecessor:** [2026-05-30-strict-likert-bench/](../2026-05-30-strict-likert-bench/) — PR #13 established that prompt iteration on cheap model cannot improve baseline (13.39/18 dev, 13.25 test). Conclusion: "model tier comparison" is the next-up test, which is this experiment.

## Question

Holding the persona prompt + QA model (`gemini-3.1-flash-lite`) constant, what's the strict-Likert effect of swapping ONLY the planner model from baseline `gemini-3.1-flash-lite` to a stronger candidate?

3 candidates:
- **A1**: `gemini-3-flash-preview` (same family, +1 tier)
- **A2**: `claude-haiku-4-5` (different family, "frontier-small")
- **A3**: `azure:gpt-5.4-mini` (different family, Azure-hosted gpt-5 series)

## Why QA model held constant

In production: Agora's managed agent runs `gpt-4o-mini` (user-confirmed). The team does NOT own this dial. The team DOES own the planner. So the actionable question is whether upgrading the planner alone is worth it.

The bench simulates persona with `gemini-3.1-flash-lite` (PR #13 baseline) rather than `gpt-4o-mini` because (a) no real OpenAI key available, (b) keeping QA model constant matches PR #13's baseline → reusable data and ONE change per arm.

## Hypothesis

- **H1**: At least one candidate beats baseline by ≥ 1.4pt on TEST (the noise floor from PR #13).
- **H2**: Improvements concentrate in D4 Canon preservation + D5 Re-anchoring power (planner-side dims), with D1-D3 + D6 unchanged or marginal (held by QA model).
- **H3** (falsification): All 3 candidates ≤ baseline → planner model is not the bottleneck. Either the SYSTEM prompt is already saturated, or the rubric is dominated by QA-side dims (D1-D3 + D6).

## Baseline (reused from PR #13)

- QA = `gemini-3.1-flash-lite` via `lib/orchestrator/gemini-client.ts`
- Planner = `gemini-3.1-flash-lite` (default `env.geminiModel`)
- Persona = extracted prod (`lib/orchestrator/index.ts` `DEFAULT_PERSONA`)
- Planner SYSTEM = extracted prod (`lib/orchestrator/resume-planner.ts` SYSTEM)
- **PR #13 measured baseline at dev 13.39 / test 13.25 / within-arm stddev 0.70**
- Data reused: `docs/experiments/2026-05-29-interrupt-smoothness/outputs/dev-iter3.json` + `2026-05-30-strict-likert-bench/outputs/baseline-test.json`

## Arms

Each arm changes **exactly ONE thing**: the planner model.

| Arm | Planner model | Family | Wire |
|---|---|---|---|
| baseline | `gemini-3.1-flash-lite` | Google | (default) |
| A1 | `gemini-3-flash-preview` | Google (same family, +1 tier) | `--planner-model gemini-3-flash-preview` |
| A2 | `claude-haiku-4-5` | Anthropic (frontier-small) | `--planner-model anthropic:claude-haiku-4-5` |
| A3 | `azure:gpt-5.4-mini` | OpenAI via Azure (`https://arclow-west.openai.azure.com/openai/v1`) | `--planner-model azure:gpt-5.4-mini` |

All 4 arms use **identical SYSTEM prompt** (extracted prod baseline). Only the model differs.

## Stop rules

- ONE pass on test. Aggregate Δ ≥ 1.4pt to declare a winner.
- No iteration loop (this is a model comparison, not prompt refinement).
- Per-slice rule: aggregate winners must not regress any slice by > 1.4pt.

# Phase 1 — Source + Split

Reused from PR #13 (so test discipline is preserved across experiments):
- **Dev**: 11 cases (C1-C10 + C2a/C2b)
- **Test (sealed)**: 8 cases (C11-C18)

# Phase 2 — Metric

Reused from PR #13:
- 6-dim × 0-3 Likert (`scripts/qa-bench/strict-likert/rubric.mjs`)
- Primary judge: Opus subagent (single trial per arm — within-arm stddev 0.70pt already pinned by PR #13's 3-trial baseline)
- Threshold: aggregate Δ ≥ 1.4pt AND no slice -1.4

## Cross-judge sanity check

For new arms (A1/A2/A3), spot-check 5 cases per arm with Gemini-3.5-flash judge to confirm rank ordering matches Opus. If Opus & Gemini disagree on aggregate ranking → re-examine.

# Pilot results (Phase 3 prerequisite, completed before full dev run)

Ran C2a × 4 arms. **A bug was caught**: original run.ts shared the qaLlm with plannerLlm (token-saving when both Gemini). This silently routed QA through the planner family when planner family changed — A3 returned `qa_answer=""` because gpt-5.4-mini's content filter blanked the QA call. Fixed: qaLlm now always constructs a fresh Gemini client.

After fix:
- All 4 arms produce valid plan + non-empty qa_answer
- qa_answer near-identical (proves QA constant ✓)
- Strategies vary (continue ×3, skip ×1) — A2 picked skip on C2a, A1/A3/baseline picked continue. **This is the kind of inter-model variation we want to measure.**
- Latency planner range 1.4-1.8s — all reasonable for prod
- A3 (Azure) requires `AZURE_OPENAI_BASE_URL` + `AZURE_OPENAI_API_KEY` env vars (added to worktree `.env.local`, **will be removed post-experiment**)

# Phase 3-5 — placeholders

(Filled as data lands; framework locked above.)

## Phase 3 (dev scores) — TBD

## Phase 5 (test verdict) — TBD

## Phase 6 (conclusion) — TBD

# Discipline self-audit (to fill at end)

- [ ] Test set sealed until Phase 5
- [ ] Pre-registered metric + threshold; no drift
- [ ] Pilot validated all metric fields populated AND caught instrumentation bug (qa_answer = "" on A3)
- [ ] Variance baseline reused from PR #13 (0.70pt stddev)
- [ ] Effect ≥ 2× variance applied (1.4pt threshold)
- [ ] Cross-judge sanity check on ≥ 5 rows per new arm
- [ ] Each arm = ONE change (only planner model)
- [ ] Per-slice scores reported (not just aggregate)
- [ ] No iter1-3 loop (this is comparison, not refinement)
- [ ] Verdict cites per-slice + aggregate
- [ ] QA model constant verified by eye on pilot outputs (near-identical qa_answer across arms)

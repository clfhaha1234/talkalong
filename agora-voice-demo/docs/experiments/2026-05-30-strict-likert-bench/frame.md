# Phase 0 — Frame: strict Likert bench on prod combo

> **Status:** Locked BEFORE Phase 3 data. /auto-lab discipline.
> **Date:** 2026-05-30
> **Owner:** Lifei

## Question

For the current bench's prod combo (QA persona = Gemini-3.1-flash-lite, planner = Gemini-3.1-flash-lite), what's the baseline score under a **strict 6-dimension Likert 0-3 rubric** judged by an Opus subagent? In ≤3 prompt iterations (no overfitting), what's the achievable max?

**Model deviation note**: User asked about "gpt-4o + gemini light" — but no `OPENAI_DIRECT_API_KEY` available in env, and all historical bench experiments + committed data use Gemini × Gemini. Running with the bench-historical combo so iteration data is comparable to past experiments. Production deployment uses gpt-4o for the agent persona (via Agora-managed BYOK); the bench's Gemini persona is a 1-to-1 prompt-equivalent simulation, not the prod model. **Conclusion will explicitly bound to "tested under Gemini × Gemini".**

## Hypothesis

H1: Baseline scores **12-14/18 mean per case** (cheap model + binary-PASS/FAIL-only tuning history).

H2: 3 iters of targeted prompt improvements (each iter targets the lowest-scoring dimension from the previous iter) can push to **15-16/18**.

H3: Beyond 16/18 = either overfit dev or Gemini-flash-lite capacity ceiling.

## Falsification conditions

- **F1**: iter3 still ≥17/18 on dev → judge too lenient OR rubric not discriminating → experiment kills, redesign rubric
- **F2**: iter3 ≤ baseline on dev → prompt iterations have no effect → model ceiling reached at baseline level
- **F3**: dev / test score gap > 2× within-arm variance → overfit alarm, kill the iter

## Baseline reference

- Persona: `lib/orchestrator/index.ts` `DEFAULT_PERSONA` (extracted via `scripts/qa-bench/extract-baseline.ts`)
- Planner SYSTEM: `lib/orchestrator/resume-planner.ts` SYSTEM (same extraction)
- Reuse committed runner output: `docs/experiments/2026-05-29-interrupt-smoothness/outputs/dev-iter3.json` — this IS the iter3 prompt from that experiment, which is the current prod baseline.

## Arms

| Arm | Change | File ref |
|---|---|---|
| **baseline** | prod prompts as deployed | see Baseline reference |
| **iter1** | ONE prompt change targeting the lowest dev dim from baseline | new prompts JSON |
| **iter2** | ONE more change targeting the lowest dev dim from iter1 | new prompts JSON |
| **iter3** | ONE more change targeting the lowest dev dim from iter2 | new prompts JSON |

Each iter is exactly ONE prompt change. No accumulated multi-changes.

## Stop rules

- ≤3 iter budget hard-locked.
- Verdict on TEST set is ONE pass.
- **Pre-registered effect threshold**: iter wins baseline iff mean total ≥ baseline + 1.0pt (out of 18 = +5.6pp), AND effect ≥ 2× within-arm variance.
- iter3 is the verdict arm regardless of which iter scored highest on dev (avoid multi-iter cherry-picking).

# Phase 1 — Source + Split

| Set | Cases | Source | Rationale |
|---|---|---|---|
| **Dev** | 11 | C1, C2a, C2b, C3-C10 | The originally locked 11 — prod prompt was iterated on these in past experiments (interrupt-smoothness, climax-leak). They reflect the surface area prod is tuned for. |
| **Test (sealed)** | 8 | C11-C18 | Newer, never used for prompt tuning. Truly held-out. **Will NOT be opened until Phase 5.** |

Distribution audit (dev set, by category):
- spoiler-defence: 3 (C2a, C7, C8) — 27%
- post-reveal-recall: 2 (C2b, C10) — 18%
- strategy-choice: 1 (C5)
- domain-explain: 1 (C4)
- canon-preservation: 1 (C3)
- off-topic: 1 (C6)
- values-engage: 1 (C9)
- language-switch: 1 (C1)

Test set distribution (sealed — listed here for transparency, NOT examined per row):
- strategy-choice: 2 (C11, C12)
- spoiler-defence: 1 (C13)
- empathy: 2 (C14, C16)
- persona-stability: 2 (C15, C17)
- domain-explain: 1 (C18)

The test set is intentionally **more** weighted to empathy + persona-stability than dev — that's a stricter generalization test (the prod prompt was barely tuned on these axes).

# Phase 2 — Metric

## 6 Likert dimensions × 0-3 = 18 max

LOCKED rubric (judge prompt below quotes this verbatim):

| Dim | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **D1 Voice integrity** | Breaks frame ("I'm AI" / "Let me think") | In role but mechanical | Naturally in role | In role + specific imagery, narrator-appropriate phrasing |
| **D2 Pedagogical instinct** | Lectures / corrects / dismisses listener | Replies but doesn't engage spirit of question | Warmly addresses + threads back | + Acknowledges the FEELING behind the ask, not just the words |
| **D3 Concision** | 3+ sentences OR 50+ words | 2 sentences with filler | 1-2 sentences, no filler | Every word earns its place |
| **D4 Canon preservation** | Leaks future / violates canon / rewrites story | Avoids forbidden but hints awkwardly | Clean — no leakage, no contradiction | + Smart redirect using the question's energy |
| **D5 Re-anchoring power** (planner-side) | Bridge ignores paused scene | Tangential, no concrete detail | References ≥1 concrete element from paused scene | Explicit "left off at X" + 2+ details |
| **D6 Elite-tutor craft** | Mechanical | Solid but forgettable | Noticeable warmth / wit; parent-quotable | The line that makes the kid lean in; callback to earlier imagery |

## Judge instructions (locked)

> You are evaluating a tutor's response to a child listener's interruption of a storybook reading. For each case, you see: the listener's question, the tutor's spoken answer, and the tutor's resume plan (bridge_text + replacement_segments). Score 6 dimensions, each 0-3.
>
> **CRITICAL CALIBRATION**: 3 is reserved for "I'd want this tutor for my own kid" responses. Most cases should score 1-2 on most dims. Default to the lower end when uncertain. A response that "doesn't violate the rule" is at most a 2, not a 3.
>
> For each dim, return: integer score 0-3 + ≤15-word reason.

## Pre-registered effect threshold

- Iter beats baseline iff `mean(iter.total) - mean(baseline.total) ≥ 1.0pt` on dev (5.6% absolute on 18-scale)
- AND `effect ≥ 2 × baseline within-arm stddev`
- AND `iter3 - baseline ≥ 1.0pt on TEST` (Phase 5 verdict)

## Variance baseline

- Run baseline judging 3× (same prompts, same case outputs, fresh Opus subagent each time). Report mean ± stddev across the 3 trials.
- Within-arm stddev is the noise floor.

## Cross-judge sanity check

- After baseline judging, also send 5 randomly-selected dev cases to a Gemini-3.5-flash judge with the same rubric.
- Verify rank correlation: if Opus's ranking of the 5 cases agrees with Gemini on ≥4/5, primary judge is trusted.
- If they disagree on ≥2/5, the metric is too subjective for single-judge — restart Phase 2.

# Phase 3-5 — placeholders

(Filled as data lands; written BEFORE Phase 3 in this frame to lock the protocol.)

## Phase 3 (dev iters)
TBD

## Phase 4 (diagnose)
TBD — each iter starts with one written hypothesis. Falsification accepted.

## Phase 5 (test verdict)
TBD — ONE pass on C11-C18.

## Phase 6 (conclusion)
TBD — full doc + 3 charts (arm-bar, forest-plot, cost-vs-accuracy).

# Discipline self-audit (filled at end)

- [ ] Test set sealed until Phase 5
- [ ] Pre-registered metric + threshold; no drift
- [ ] Pilot run validates all metric fields populated
- [ ] Variance baseline measured (≥3 trials)
- [ ] Effect ≥ 2× variance, not just ≥ threshold
- [ ] Cross-judge sanity check on ≥5 rows
- [ ] Each iter changed ONE thing
- [ ] Iter hypotheses written in advance
- [ ] 3-iter cap enforced
- [ ] Verdict locks LATEST iter (iter3), not best-scoring
- [ ] Per-slice scores reported (per-dim + per-category)

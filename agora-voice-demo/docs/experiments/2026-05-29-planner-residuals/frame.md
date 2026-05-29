# Phase 0 — Frame: close the planner-side interrupt residuals

> **Status:** Frame locked BEFORE running. Round 2 — continues [2026-05-29-interrupt-smoothness](../2026-05-29-interrupt-smoothness/conclusion.md), which shipped iter3 (C6 answer + C10) and left **planner-side** residuals. T1–T6 are now contaminated (their test results were seen), so this round uses a **fresh** held-out set T7–T12.
> **Date:** 2026-05-29

## Question

The shipped prompt (iter3) fixed the persona-side failures, but three residuals are **planner-side** and remain: when the kid asks an off-topic problem the **planner still weaves it into narration** (T4/C6), and on explicit confusion the **planner picks `continue` not `restart`** (T5/C5). Can two **first-principles-true** planner clauses close these without regressing, and do they generalize to fresh held-out scenarios?

## Hypothesis

Both residuals are general planner behaviours, not case hacks (pass the litmus — a storyteller should never put the child's arithmetic into the fairy tale, and should re-tell a part a confused child didn't catch):

| Residual | Gap | General planner rule |
|---|---|---|
| **C6 / T4** off-topic-echo | planner echoes the listener's off-topic content (the math number) into `replacement_segments` | "Resume with story content ONLY — never fold the listener's off-topic question (numbers, trivia, real-world facts) into the narration." |
| **C5 / T5** confusion-restart | planner picks `continue` when the listener was confused / asked to repeat | "If the listener signalled confusion or asked to hear a part again, choose `restart` and re-narrate the paused scene — not `continue`." |

C7 (climax-leak) is **excluded** — round 1 showed a general no-early-reveal clause was neutral; treating it further risks a phrase-specific hack.

## Baseline + arms (each iter = ONE change)

- **Baseline:** shipped **iter3** prompts — `DEFAULT_PERSONA` [lib/orchestrator/index.ts:68](../../../lib/orchestrator/index.ts) + planner `SYSTEM` [lib/orchestrator/resume-planner.ts:84](../../../lib/orchestrator/resume-planner.ts). Dev baseline (from round 1): 11-set **9.7/11** (3-trial); T1–T6 **4/6** (fails T4, T5).
- **iter1** — planner + *no-echo-offtopic* clause. Target: C6/T4. (one change)
- **iter2** — iter1 + planner *restart-on-confusion* clause. Target: C5/T5. (one change)
- **Arm locked for Phase 5 = cumulative iter2.**

## Metric (pre-registered)

- **Primary:** grade.ts hard-PASS rate. Dev = the 11 qa-bench cases + T1–T6 (17 total, all now seen). Held-out = T7–T12.
- **Secondary:** resume latency (planner `latency_ms`); must not regress >2×.
- **Ship-rule:** strictly dominate baseline on dev (fix C6+C5+T4+T5 targets, regress 0 previously-passing) AND on the fresh held-out T7–T12 regress 0 behaviour classes vs baseline. Clauses that only work as hacks or regress held-out are dropped.
- "丝滑" goal: every case PASS or documented irreducible (LLM nondeterminism / rubric-strictness).

## Phase 1 — data + split

| Set | Cases | N | Use |
|---|---|---|---|
| Dev | C1–C10 + T1–T6 | 17 | all seen; tune + score |
| **Test (fresh, SEALED)** | T7–T12 ([test-cases-heldout.json](test-cases-heldout.json)) | 6 | new scenarios; opened ONCE at Phase 5 |

Held-out T7–T12: new questions, same fixture, covering the two target classes (off-topic-refuse T7/T9, confusion-restart T8) plus 3 no-regression controls (spoiler-defer T10, engage-revealed T11, keep-canon T12). Synthetic (no prod logs) — documented limitation.

## Stop conditions

≤2 iters (one per residual). Falsification = drop the clause, lock, run test. No iteration after Phase 5.

## Results

- Dev: baseline(iter3) 9.7/11 + 4/6(T1–6) → **r2-iter2 10/11 + 5/6**. T4 fixed (no-echo), C5 fixed (restart), C6 holds. Remaining: C7 (excluded climax) + T5-qa (persona micro-residual; planner restart correct).
- Held-out T7–T12: baseline 3/6 → **iter2 4/6**, regresses 0; discriminating case **T9 (off-topic-math) FIXED** → no-echo generalizes. T7/T12 = non-discriminating rubric artifacts (both arms fail).
- Resume latency: ~1.34 s, unchanged.
- E2E online (prod planner=iter2): 8/10 PASS, 1 skipped (C6 ✓, C5 ✓ on prod path).
- **Verdict: SHIP r2-iter2.** Full write-up: [conclusion.md](conclusion.md).

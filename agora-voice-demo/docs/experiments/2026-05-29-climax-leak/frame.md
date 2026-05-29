# Phase 0 — Frame: close the C7 climax-leak residual (workflow vs model)

> **Status:** Frame locked BEFORE running. Round 3 — the only structural residual left after rounds 1–2. User chose "A + B": test a workflow fix AND a stronger planner model as two arms, pick the winner. Fresh held-out T13–T18 (T1–T12 contaminated).
> **Date:** 2026-05-29

## Question

When the listener interrupts near the climax (paused at s4), the planner intermittently leaks the s5 resolution ("the queen's glow steadied", "Mosk hummed along") into the resume — C7 fails ~2–3/3. Two prompt clauses (no-early-reveal) were neutral. Is this fixable by (A) a **workflow** change that stops handing the planner the ending text, or (B) a **stronger planner model**, without regressing other cases?

## Hypothesis

The leak is **structural, not a prompt problem**: `handleQaEnded` passes the planner the *full text* of the next scenes ([index.ts:278](../../../lib/orchestrator/index.ts)), so at the climax it literally hands over s5's outcome and then asks it not to reveal it. Either remove the temptation (A) or use a model that resists it (B).

## Baseline + arms (each changes ONE thing)

- **Baseline:** shipped prod — planner `SYSTEM` (round-2) on `gemini-3.1-flash-lite`, lookahead = next 2 scenes full text. C7 ≈ 0/3 pass (rounds 1–2).
- **Arm A (workflow):** `--redact-ending` — the story's FINAL scene in the planner's lookahead is truncated to its first sentence (enough to transition toward, not enough to leak the outcome). Model unchanged.
- **Arm B (model):** `--planner-model gemini-3.5-flash` — stronger planner; lookahead unchanged.

## Metric (pre-registered)

- **Primary:** C7 pass-rate over **3 trials** (the target; grade.ts deterministic forbidden-substring + judge). Baseline ≈ 0/3.
- **Guard:** 11-set total pass-rate must not regress (mean ≥ baseline 9.7/11) — a fix that closes C7 by dumbing down other resumes is not a win.
- **Held-out:** T13–T18 (fresh) — climax-leak analogues (T13, T14) + controls (T15 off-topic, T16 engage-revealed, T17 defer, T18 language).
- **Ship-rule:** an arm ships iff C7 pass-rate ≥ 2/3 AND 11-set total not regressed AND held-out regresses 0 behaviour classes. If both arms qualify, prefer the one with lower cost/latency + simpler change.

## Phase 1 — split

Dev = 11 qa-bench cases (C7 lives here) — 3 trials/arm. Held-out = T13–T18 (sealed, opened once). Synthetic (no prod logs).

## Stop conditions

2 arms, no iteration (each arm is a single clean change). Pick winner on held-out. If neither closes C7 ≥2/3, conclude "C7 is model-tier nondeterminism — ship current state, document."

## Results

- Dev (3 trials): C7 — baseline **0/3**, armA **3/3**, armB **0/3**. 11-set total — baseline 10.0, **armA 10.7 (11/11 ×2)**, armB 9.0 (regressed).
- Held-out T13–T18: baseline 5/6 → armA 5/6; **T14 climax question FAIL→PASS (generalizes)**; T16 flip = false regression (paused at last scene → flag can't touch its input; qa-answer noise).
- E2E online (prod path + fix): **9/10 PASS, 1 skipped — C7 now PASSES**.
- Latency ~1.4 s, unchanged. **Verdict: SHIP armA, kill armB.** C7 was structural (planner handed the ending), not model-tier. Full write-up: [conclusion.md](conclusion.md).

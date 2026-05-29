# QA & Resume Benchmark — Phase 0 Frame

**Date:** 2026-05-28
**Owner:** lifeichen

## Question

When a child listener interrupts narration with a question, does our current system (a) answer the question well *in narrator persona*, and (b) bridge gracefully back to the main story without changing the canon? Across 10 representative interruption scenarios, does the current `DEFAULT_PERSONA` + `resume-planner SYSTEM` jointly satisfy a hard rubric?

## Hypothesis

The current prompts cover the obvious cases (factual Q&A, tangent) but likely under-serve three sharp edges the user called out:

1. **Language switch** — listener asks for Chinese; persona has no explicit policy and may either silently switch (breaking the canonical English audio/TTS pipeline) or refuse rudely.
2. **Spoiler avoidance** — listener asks "why does character X do Y?" where Y hasn't happened yet; persona may answer truthfully and spoil the story, instead of teasing and deferring.
3. **Canon preservation** — listener proposes a different ending or asks the narrator to change a character's choice; resume-planner has no "user cannot rewrite the story" guard.

## Baseline

- Persona answering: `DEFAULT_PERSONA` constant at `lib/orchestrator/index.ts` (the warm-storybook-narrator prompt). Note: in production this prompt runs through the managed Agora agent's LLM; for offline bench we run the same string through Gemini (the same model the resume-planner uses), accepting a small persona-drift risk vs. prod's LLM (out of scope to control here — bench measures prompt quality, not vendor delta).
- Resume planner: `SYSTEM` constant at `lib/orchestrator/resume-planner.ts:84`, invoked via `planResume(...)` at `lib/orchestrator/resume-planner.ts:239`.
- Model: `gemini-3.1-flash-lite` (current default at `lib/orchestrator/index.ts:_`).
- Temperature: 0.7 (planner default).

## Arms

This is a **baseline-only golden-set bench**, not an A/B. If baseline passes the threshold, ship the bench as a regression guard. If baseline fails, then *and only then* we enter iter 1-3 with one prompt-change-per-iter to fix the failing slice.

- **Arm 0 = baseline** (current prompts, current model).
- **Arm 1+** = added only if baseline fails. Each arm changes ONE thing (one named addition to persona prompt OR one named addition to planner prompt).

## Metric

Pre-registered rubric is **per-case binary PASS / FAIL**, judged by Claude Code reading the raw outputs. Each case has:

- **Hard criteria** — must all hold. Example: "answer does not name antagonist X" for a spoiler case.
- **Soft criteria** — bonus, doesn't decide pass/fail. Example: "bridge uses warm storyteller tone".

**Aggregate metric:** `pass_rate = passed / 10`.

**Pre-registered threshold:** ship-as-is requires `pass_rate ≥ 9/10` AND no test case in {C1, C2a, C2b, C3} (the user-named ones) fails. Below that, iterate.

## Stop conditions

- `pass_rate ≥ 9/10` AND user-named cases all green → SHIP baseline, commit bench as regression guard, conclude.
- `pass_rate < 9/10` → run iter 1: one named prompt change, re-bench, judge. Cap at iter 3.
- After iter 3, lock latest hypothesis-driven arm regardless of score (auto-lab discipline) — write conclusion citing remaining gaps as "next experiment" not "more iterations".

## Data split

This is a single fixture (1 story × 10 scenarios). No held-out test split is meaningful at N=10. Discipline substitute: **the rubric is written and committed BEFORE any LLM call runs**. We don't tune the rubric to match the output we see.

## Anti-overfitting guards (auto-lab discipline)

- Rubric locked here, in this doc, before any run.
- If iterating, each iter changes ONE prompt clause and the case under test is named in the iter hypothesis.
- Cross-check: at least 1 case run twice (variance proxy) to confirm we're not hallucinating a pass on a noisy output.
- No editing of any case AFTER seeing the output. If a case turns out to be ambiguous, the case is marked AMBIGUOUS and excluded from aggregate, not silently rewritten.

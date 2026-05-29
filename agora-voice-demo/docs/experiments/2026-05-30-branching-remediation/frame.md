# Phase 0 — Frame: does branching need a static DAG, or runtime remediation?

> **Status:** Frame locked before runs. Continues the generality experiment (which proved LINEAR agendas
> generalize) by testing the one untested capability: branching (wrong answer → recover).
> **Date:** 2026-05-30
> **Design call (from discussion):** agenda stays LINEAR; branching is RUNTIME ("见机行事"), not a
> pre-authored static DAG (the Pipecat Flows approach). Author-time adds at most an optional 1-line
> remedial hint per elicit. The remedial sub-flow re-teaches the SAME target (not new content), then rejoins.

## Question

For a TEACHING agenda, when a learner answers a load-bearing concept wrong, can the current engine recover
them — or does it need a new `remediate` action (re-TEACH, then re-ask) distinct from the existing
`follow_up` (re-ASK only)?

## Hypothesis

`follow_up` (re-ask the same/reframed question) is insufficient for teaching: a learner who didn't
understand stays wrong no matter how you re-ask — they need to be re-TAUGHT. So the current engine will
FAIL to cover a "wrong-but-corrigible-by-reteaching" learner, proving the need for a minimal `remediate`
increment (the decision brain emits an explanation, the engine speaks it, then re-asks). This is the
located gap; it is a small engine change, NOT a static-DAG rewrite.

## Metric (pre-registered) — STRICTER than the generality experiment

Teaching success = load-bearing elicit segments must be **COVERED** (an adequate answer was achieved),
NOT merely `given_up`. (Interview tolerates given_up; teaching does not — giving up on a load-bearing
concept means the learner didn't learn it.) Primary metric: **load-bearing COVERED rate**.

## Arms

- **baseline (current engine):** `follow_up` re-asks only. Expected: cannot recover → coverage(by-covered) fails.
- **arm `remediate`:** engine gains a `remediate` action = speak a re-explanation (the brain's text) then re-ask.
  Expected: recovers the corrigible learner → covered.

## Discriminating persona

`wrong-corrigible`: answers the load-bearing question WRONG initially; recovers (answers right) ONLY if the
agent's prior utterance RE-EXPLAINED the concept (new framing/teaching), NOT if it merely re-asked. This
persona is the falsifier — it separates re-ask from re-teach.

## Stop conditions

If baseline fails-to-cover AND `remediate` covers → ship `remediate` as the located branching increment
(runtime, not static DAG). If baseline already covers (re-ask alone teaches) → hypothesis falsified, no
increment needed. ≤1 engine change (the `remediate` action). No static-DAG work either way.

## Results — runtime remediation wins; no static DAG needed

Strict teaching metric = load-bearing elicit `covered` (truly learned), not merely `given_up`. Real Gemini, `teach` agenda + `wrong-corrigible` persona:

| Arm | q1 covered (3 runs) |
|---|---|
| baseline (re-ask / follow_up only) | **0/3** (always given_up — never re-taught) |
| arm `remediate` (re-teach then re-ask) | **2/3** (recovered; 1/3 a hard learner → graceful give-up) |

**Verdict: ship `remediate`.** 0/3 → 2/3 is a clear win on the strict metric (far above the ±1 noise). The engine now genuinely re-explains the concept on a wrong answer, after which the corrigible learner answers correctly.

**The answer to "do we need branches in the outline?": NO.** The `teach` agenda is a **linear** deliver+elicit; the branch is a **runtime** re-teach the decision brain composes on the fly ("见机行事"). The located increment was NOT a static DAG / segments-with-conditional-successors — it was a single new **decision action** (`remediate`). So: **linear typed-segment agenda + a richer decision enum suffices for teaching-branching** — Pipecat's static DAG is over-engineering for the LLM-native case. Termination preserved (the attempt cap + per-segment turn ceiling bound remediate exactly like follow_up).

# Conclusion — branching = runtime remediation, not a static DAG

> Tests the one capability the generality experiment left untested: branching (wrong answer → recover).
> Falsifiable arms on a teaching agenda + a "wrong-but-corrigible" learner. See [frame.md](./frame.md) for the table.

## Question

For teaching, when a learner answers a load-bearing concept wrong, does the engine need a pre-authored
static DAG of branches (Pipecat Flows style), or can a LINEAR agenda + a runtime re-teach recover them?

## Result (strict teaching metric: load-bearing elicit must be COVERED, not merely given_up)

- **baseline** (current engine, `follow_up` = re-ask only): **0/3** covered — always `given_up`. Re-asking a
  confused learner never teaches them; the loop gives up. (Run 3: learner *was* corrigible and eventually
  answered right, but the engine had no re-teach path and gave up first.)
- **arm `remediate`** (re-EXPLAIN, then re-ask): **2/3** covered. The brain composes a fresh explanation,
  the engine speaks it, the re-taught learner answers correctly. (1/3 a hard learner → graceful give-up.)

0/3 → 2/3 on the strict metric, far above the ±1-case noise. **Ship `remediate`.**

## The architecture answer

**No static DAG needed; do not pre-author branches.** The `teach` agenda is a **linear** deliver+elicit.
The branch is a **runtime** improvisation — a `remediate` action where the decision brain re-explains the
SAME target on the fly, then re-asks, then rejoins the linear line. The located increment was a single new
**decision-enum value** (`accept | follow_up | give_up | remediate`), NOT segments-with-conditional-successors.

So: **linear typed-segment agenda + a richer single-shot decision enum suffices for teaching-branching.**
This is strictly leaner than Pipecat Flows' pre-authored node graph, and LLM-native: it covers *any* wrong
answer (not only pre-imagined ones), the remedial content is the existing target re-explained (no new WHAT,
no canon risk), and the deterministic spine still owns control — `remediate` is bounded by the same attempt
cap + per-segment turn ceiling as `follow_up`, so termination is preserved.

This confirms the design intuition: **一般线性,见机行事** — the agenda stays linear; branching is a runtime
action, not a structure to author ahead.

## What to test next

A teaching flow where remediation should draw on the ORIGINAL deliver content (not just the target) — i.e.
should the elicit segment carry a back-reference to the concept's deliver text so the re-teach is richer?
Minor; defer until a real lesson shows the target-only re-explanation is too thin.

## Discipline self-audit
- [x] Pre-registered STRICTER metric for teaching (covered, not given_up) before running
- [x] Falsifiable baseline first (0/3) — proved the gap before building the fix
- [x] Discriminating persona (wrong-corrigible) separates re-ask from re-teach
- [x] One engine increment (a decision-enum value), not a DAG rewrite; termination preserved (cap + ceiling)
- [x] Real-Gemini confirmation (3 runs each arm), effect far above noise

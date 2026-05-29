# Conclusion — typed-segment generality experiment

> One I/O-injected engine (`scripts/generality-exp/engine.ts`), three agendas spanning the
> content-ownership spectrum, persona stress-tests. **Verdict: generality PROVEN for linear agendas.**

## Question (verbatim)

Does ONE unchanged engine cover storytelling (deliver-only), HR interview (elicit-only), and
onboarding (mixed) by swapping agenda **data only, no engine code**?

## Result

7/7 episodes pass, **100% load-bearing coverage on all three agendas** (story 4/4, hr 3/3, onboard 4/4),
graceful non-response on the `silent` persona, zero WHAT-violations. The diff between runs is literally
the `--agenda` flag. The same `runAgenda` handled deliver, elicit (accept / follow-up / give-up),
non-response timeout, and a HOW directive (`meta` persona) — see [frame.md](./frame.md) for the table and
`outputs/*.json` for full transcripts.

(No comparative `arm-bar`/`forest-plot` charts: this is a coverage **pass-matrix**, not a baseline-vs-arm
comparison — a results table is the honest representation.)

## What this proves — and what it doesn't

**Proven:** the typed-segment abstraction (`deliver | elicit`, with adequacy-gated completion) is
sufficient to express all three modes with one deterministic spine. No hidden storytelling-coupling
surfaced. This is the generality claim the architecture rested on.

**NOT tested (the honest gap):** all three agendas are **linear sequences**. The experiment does not
exercise **branching** — "if the answer is wrong, enter a remedial sub-flow, then rejoin the main line."
Our engine does *follow-up* (re-ask the same segment) but not *branch-to-a-different-sub-agenda-then-rejoin*.

## Cross-check against industry frameworks (LangGraph, Pipecat Flows)

Both leading frameworks independently converged on this architecture, which corroborates the design:

| Their concept | Our equivalent | Status |
|---|---|---|
| LangGraph: stateful machine ON TOP of the reactive LLM; persistence as first-class | spine + ADR Decision 1 (LLM proposes, spine disposes) | ✅ same thesis |
| LangGraph: checkpoint + `thread_id` (load exact position to resume) | `ProgressState` pointer + `session_id` | ✅ position-recovery present |
| LangGraph: `interrupt()` / `Command(resume=True)` | BRANCH → `handleQaEnded` → resume-planner → exitBranch | ✅ |
| Pipecat: DAG nodes, per-node restricted LLM scope | typed segments, single-shot scoped decisions | ✅ |
| Pipecat: gated access (advance only after mastery) | elicit adequacy gate (accept/follow-up/give-up) | ✅ |
| Pipecat: structured progression (forced pipeline) | the agenda sequence | ✅ |
| Pipecat: transport decoupled from dialogue logic | I/O-injected engine (Actuator/Listener) | ✅ (built this task) |
| Pipecat: subagent handles digression, deterministic handler reclaims control | proposer/disposer (spine reclaims after QA) | ✅ |
| **Pipecat: branching conversations (wrong → remedial branch → rejoin)** | **linear sequence only** | ❌ **gap** |
| **LangGraph: durable checkpoint persistence (crash recovery, replay)** | **in-memory ProgressState** | ❌ gap (productionization) |

Two genuine borrows (取长补短): **(1) a branching/DAG agenda** (architecturally interesting, testable now);
**(2) durable checkpoint persistence** (defer — only matters when productionizing multi-session/crash-recovery).

## What to test next

Add a **4th tiny agenda that REQUIRES branching** — an elicit segment whose *wrong* answer must route into a
remedial deliver+re-ask sub-flow, then rejoin the main line. If the current engine can express it by data
only → generality extends to DAGs. If it forces an engine change (segments need conditional successors) →
that's the precise, located increment: grow `AgendaSegment` from a linear list into a node with
`on_pass` / `on_fail` successors. (This is the one place Pipecat Flows has something our linear model
provably doesn't.)

## Discipline self-audit
- [x] Pre-registered metric (100% load-bearing coverage, same engine across agendas) + guards (graceful, no-WHAT)
- [x] Pilot N=1 (hr/cooperative + hr/silent) before the matrix; all grade fields populated
- [x] Personas are independent LLM calls (no shared state with the engine's decision LLM)
- [x] Scope honesty: linear-only proven; branching explicitly flagged as untested, not hand-waved
- [x] Engine code identical across all 3 agendas (verified: only the `--agenda` flag differs)

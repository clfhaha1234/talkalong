# Phase 0 — Frame: typed-segment generality experiment

> **Status:** Frame locked before the matrix run. Demo/exploration.
> **Date:** 2026-05-30
> **Design:** [../../plans/2026-05-29-typed-segment-engine-design.md](../../plans/2026-05-29-typed-segment-engine-design.md)
> **Engine under test:** `scripts/generality-exp/engine.ts` (`runAgenda`), I/O-injected, single-shot decisions.

## Question

Does ONE unchanged engine cover all three content-ownership modes — storytelling (deliver-only),
HR interview (elicit-only), onboarding (mixed) — by swapping **agenda data only, no engine code**?

## Hypothesis

The typed-segment abstraction (deliver | elicit) is sufficient; the same `runAgenda` handles all three.
If any agenda forces an engine change, that diff is the hidden storytelling-coupling to fix.

## Metric (pre-registered)

- **Primary:** load-bearing coverage = **100% on all three agendas** (every load-bearing segment reached:
  delivered / covered / gracefully given-up — given-up counts as reached, not dropped), with the **same
  engine binary** across agendas (the diff between runs is only the `--agenda` flag).
- **Guards:** graceful-nonresponse on the `silent` persona; zero WHAT-violations.
- **Verdict rule:** PASS (generality proven) iff all three agendas hit 100% load-bearing coverage with no
  engine code change; otherwise the failing agenda localizes the coupling.

## Matrix

| Agenda | Personas |
|---|---|
| story (deliver-only) | cooperative (persona irrelevant — no elicit) |
| hr (elicit-only) | cooperative, shallow, silent, meta |
| onboard (mixed) | cooperative, silent |

`silent` stresses graceful non-response; `meta` stresses HOW-directive → policy flag; `shallow` stresses
follow-up. Personas are independent Gemini calls (no shared state with the engine's decision LLM).

## Results — generality PROVEN

Same engine (`runAgenda`), only the `--agenda` flag changed between runs:

| Agenda | Persona | pass | load-bearing coverage | graceful | forbidden |
|---|---|---|---|---|---|
| story (deliver) | cooperative | ✅ | 4/4 | — | 0 |
| hr (elicit) | cooperative | ✅ | 3/3 | — | 0 |
| hr (elicit) | shallow | ✅ | 3/3 | ✅ | 0 |
| hr (elicit) | silent | ✅ | 3/3 | ✅ (give-up each) | 0 |
| hr (elicit) | meta | ✅ | 3/3 | — | 0 |
| onboard (mixed) | cooperative | ✅ | 4/4 | — | 0 |
| onboard (mixed) | silent | ✅ | 4/4 | ✅ | 0 |

**Verdict: PASS.** One unchanged engine covered all three content-ownership modes (AI-output-dominant, user-input-dominant, bidirectional) at 100% load-bearing coverage, by swapping agenda DATA only. No agenda forced an engine change → the typed-segment abstraction is sufficient for these three; no hidden storytelling-coupling surfaced.

**Caveat (real, see conclusion):** all three agendas are LINEAR sequences. This does NOT test branching ("wrong answer → remedial sub-flow → rejoin") — the one capability competitor frameworks (Pipecat Flows) build that a linear sequence cannot express. That's the next test.

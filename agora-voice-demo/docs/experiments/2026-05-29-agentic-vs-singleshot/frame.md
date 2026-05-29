# Phase 0 — Frame: agentic tool-loop vs single-shot for the resume decision

> **Status:** Frame locked BEFORE running. This experiment supplies the **data** for the architecture decision (current bespoke single-shot planner vs a more agentic tool-using agent).
> **Date:** 2026-05-29

## Scope (what this experiment can and cannot settle — read first)

The architecture candidates (A current / B hybrid-our-code / C hybrid-Agora-MCP / D full-agentic) differ on **two axes**:
1. **How the resume decision is made** — a single structured LLM call (today) vs an **agentic tool-loop** (the LLM autonomously fetches state via tools, then decides). ← **offline-measurable, this experiment**
2. **Who hosts the loop** — our code vs Agora's native `enable_tools`/MCP. ← needs a **live Agora+mic spike**, NOT offline-measurable; flagged as follow-up.

Decision quality + latency + reliability of axis (1) is the heart of "should we go more agentic." B and C **share the same agentic decision mechanism** (they differ only in hosting), so measuring the mechanism offline tells us whether the agentic direction is even worth the hosting spike. If the agentic mechanism doesn't beat single-shot on quality, then A/B-single-shot wins and C/D are not justified — no spike needed.

## Question

For the resume decision (interrupt → `{resume_strategy, bridge_text, replacement_segments, active_scene_id}`), does an **agentic tool-loop** (LLM with tools `get_paused_scene` / `get_next_scenes` / `get_qa_history` / `get_percent_spoken` / `submit_plan`, deciding autonomously) produce **better decisions** than the current **single-shot structured call** — and at what latency / reliability / token cost?

## Hypothesis

On this task the agentic loop will **not** improve decision quality (all inputs are small and already known up front — there's nothing to "discover" via tools), while it costs **≥2× latency** (multiple round-trips), **lower valid-plan reliability** (loops can fail to terminate / emit malformed plans), and **higher token cost**. → favors keeping the decision **single-shot** (Approach A/B); the agentic/Agora path (C/D) is unjustified unless a future task needs multi-step reasoning the single-shot can't express.

## Baseline + arm (each changes ONE thing)

- **Baseline:** current single-shot planner — `resume-planner.ts SYSTEM` via `scripts/qa-bench/planner.ts`, one Gemini call, structured JSON out. Model `gemini-3.5-flash`.
- **Arm `agentic`:** same model, same SYSTEM rules, but the planner is a **tool-loop**: the LLM must call tools to fetch the paused scene / next scenes / qa history / %-spoken, then call `submit_plan`. We reuse the baseline's `qa_answer` per case so the ONLY thing varied is the planner mechanism (clean isolation).

## Metric (pre-registered)

- **Primary:** decision quality = `grade.ts` PASS-rate on the 11 dev cases (same rubric, same `gemini-3.5-flash` judge). Because `qa_answer` is shared, the planner-side checks carry the signal.
- **Secondaries:** (1) p50/p95 **latency** per decision; (2) **valid-plan reliability** = % of cases the loop terminates with a schema-valid plan (no fallback/junk); (3) **token cost** per decision; (4) **round-trips** per decision.
- **Threshold (pre-registered):** the agentic arm "wins" (and the architecture should move agentic) ONLY if quality ≥ baseline **+1 case (≈+9pp)** on dev AND latency not >2× baseline. If quality is flat/worse → single-shot wins; the agentic premium is unjustified and C/D are dropped (no live spike needed).

## Phase 1 — data + split

Dev = the 11 qa-bench cases (the interrupt golden set). This experiment does **not iterate the arm against case outputs** (it compares two fixed mechanisms), so contamination risk is low; the 11-set is the comparison surface. 3 trials/arm for variance (the planner runs at temp 0.7).

## Phase 2 — instrumentation

`scripts/qa-bench/agentic-planner.ts`: reads a baseline run output (for shared `qa_answer` + case inputs), runs the tool-loop per case, writes a results file in the same shape as `run.ts` (so `grade.ts` scores it identically). Captures latency, tokens, round-trips, terminated-valid flag.

## Stop conditions

≤3 iterations on the agentic arm (only to fix instrumentation/prompt bugs, not to chase quality). Lock, verdict, conclusion. The hosting axis (Agora-native) is explicitly out of scope → documented as the live-spike follow-up.

## Results

- Quality (3-trial): single-shot **10.0/11** vs agentic **9.67/11** — flat/slightly-worse, both fail only noise cases C2a/C7/C9.
- Cost: latency **1293ms → 4717ms (3.65×)**, tokens **~5×**, round-trips 1 → 4.5. Agentic valid-plan 11/11 (reliability OK; cost is the problem).
- **Verdict: SHIP single-shot (Approach A/B); kill agentic.** Fails the pre-registered threshold on both quality (−0.03, needed ≥+1) and latency (3.65×, needed ≤2×). C/D "more agentic" direction not supported by data; Agora-hosting spike deprioritized. Full write-up: [conclusion.md](conclusion.md).

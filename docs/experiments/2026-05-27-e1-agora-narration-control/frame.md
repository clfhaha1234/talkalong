# E1 — Agora Narration Control Method (Phase 0 Frame)

> **Status:** Pre-registered. Locked before any data collection.
> **Date:** 2026-05-27
> **Owner:** Lifei
> **Parent PRD:** [`docs/plans/2026-05-27-proactive-tutor-engine-prd.md`](../../plans/2026-05-27-proactive-tutor-engine-prd.md) §9.E1
> **Skill used:** auto-lab
> **Compute budget:** ~1 day end-to-end. ≤3 Phase-4 iterations.

---

## 0.1 Question

> **Of three candidate methods for getting Agora's ConvoAI agent to speak our pre-scripted narration with reliable mid-utterance barge-in, which one best satisfies the proactive-tutor experience requirements?**

Specifically: which method produces (a) the spoken text we wanted, (b) interrupted within 300ms of our interrupt call, (c) resumed speech starting within 800ms of our next speak call, (d) over five consecutive cycles without degradation?

This is the **architecture-lock experiment** for the PRD. Whoever wins becomes the foundation of the orchestrator. Whoever loses goes in the rejected-options appendix.

## 0.2 Hypothesis

**H1 (primary):** Arm 1 (`/speak` + `/interrupt` via the Agora REST API / SDK) is the cleanest match for Option A from the PRD — it gives our orchestrator deterministic control over both narration text and interrupt timing, with no LLM drift on what is said.

**H1 sub-claim:** All three arms will pass the speak-start latency criterion (TTS first audio under ~800ms is a published Agora property), but they'll diverge on **interrupt fidelity** and **content correctness**. Arms that route through an LLM will be slower to interrupt or more prone to drift on what they speak; the direct-`/speak` arm is the only one that bypasses the LLM entirely.

**H1 falsification condition:** Arm 1 fails ≥1 pass criterion, or another arm beats it on a primary metric by >2× variance.

## 0.3 Baseline

**Native Agora LLM-driven mode** — the system as it is running right now at `localhost:3000`:

- Reference: `<repo>/agora-voice-demo/app/api/invite-agent/route.ts:16-39` (the Ada system prompt + greeting)
- Pipeline: Deepgram STT → OpenAI `gpt-4o-mini` LLM → MiniMax `speech_2_8_turbo` TTS
- Behavior: agent speaks an opening greeting, then waits for user input and responds. **It has no concept of "narration segment to deliver." Everything it says is the LLM responding to user turns.**

This is the strawman, not because we want it to lose, but because the PRD explicitly proposes replacing it with one of the arms. The baseline measures "how does the off-the-shelf demo behave when you try to drive proactive narration through it?" — which is mostly **it doesn't**. The baseline is expected to fail the correctness criterion in particular: it won't read our segment text verbatim. We score it anyway so the comparison is honest.

## 0.4 Arms (each changes ONE thing vs. baseline)

### Arm 1 — Push-text-injection (`/speak` + `/interrupt`)

**What changes vs. baseline:** the LLM is bypassed for narration. Our orchestrator calls `session.say(segment_text, { priority: "INTERRUPT" })` to push the pre-scripted segment text directly to TTS. To barge in, calls `session.interrupt()`, then pushes the next segment with another `session.say()`.

**SDK reference:** `agora-agent-server-sdk` — `session.say()` maps to `POST /agents/{id}/speak`, `session.interrupt()` maps to `POST /agents/{id}/interrupt`. Verified in [skills/agora ConvoAI architecture reference](https://github.com/AgoraIO/skills/blob/main/skills/agora/references/conversational-ai/architecture.md).

**Why we expect it to win:** zero LLM drift on narration content. Bypasses round-trips. Maps cleanly to the orchestrator state machine in PRD §5.

**Critical unknowns:**

- Whether `session.say()` competes with the LLM's own intent to speak (e.g., greeting message that fires on session start)
- Whether the `INTERRUPT` priority enum actually preempts in-flight TTS or just queues
- Whether RTM `agent_state` transitions land before or after audio actually starts/stops (timing instrumentation depends on this)

### Arm 2 — BYOK-LLM proxy (Gemini behind `app/api/chat/completions/route.ts`)

**What changes vs. baseline:** the Agora-resold OpenAI LLM is replaced by **our local proxy**, which speaks Gemini 2.5 Flash via the OpenAI-compatible endpoint shape. The proxy is given the orchestrator's current segment text and instructions to "respond with exactly: `<segment_text>`" (no creative latitude). The Agora session itself still speaks via its own TTS, driven by the LLM output.

**Configuration:** `NEXT_LLM_URL=http://localhost:3000/api/chat/completions`, `NEXT_LLM_API_KEY=<gemini-proxied-key>`. Quickstart's existing route at `app/api/chat/completions/route.ts` is the proxy; it relays to `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (Gemini's OpenAI-compat endpoint).

**Why this is a real candidate:** it's the cleanest path for "Agora is voice I/O, our LLM is the brain" — exactly the user's framing ("agora 主要是传话的和QA的"). No need to call `/speak` because the LLM-shaped flow is preserved.

**Critical unknowns:**

- Does the LLM proxy honor "speak this verbatim" reliably, or does it paraphrase?
- Are there interrupts to test? The user has to *cause* the agent to speak — usually via a user turn. How do we trigger narration from a server-side script with no live mic?
- Trick option: use `session.appendInputAudio()` or fake-user-message injection — does the SDK / REST API expose a way to push fake user messages? **TBD in Phase 2 setup.** If no clean injection path exists, this arm degrades to "LLM is correct but we can't trigger barge-in tests without a real microphone."

### Arm 3 — System-prompt-swap (`/update`)

**What changes vs. baseline:** the system prompt is rewritten via `session.update()` to be a *narration directive* — "Read this aloud verbatim, then stop and wait. Segment text: <text>." Agora's LLM then generates an utterance matching the directive on its next speaking turn.

**Why we still test it:** the v0.1 PRD assumed this would work; the v0.2 PRD §4.3 (Option B) wants empirical mode-discipline data. E1 measures it on a small scale; E3 measures it on the full mode-swap rubric later.

**Critical unknowns:**

- Same trigger problem as Arm 2 — when does the agent *decide* to speak after `update()`? Does it speak immediately, or wait for the next user turn?
- `/update` overwrites `params` entirely — must reconstruct the full object every time. Verbosity, not a blocker.
- LLM drift: even with "verbatim" instruction, does `gpt-4o-mini` paraphrase, summarize, or skip lines?

---

## 0.5 Stop Conditions

Each arm is scored per-row against four pass criteria. **An arm passes if it satisfies ALL FOUR on at least 4 of 5 cycles per row.**

| # | Criterion | Threshold | Source |
|---|---|---|---|
| C1 | **Interrupt → silence latency** | < 300 ms | PRD §9.E1 pass criteria |
| C2 | **Speak-start latency** (call → first TTS audio in RTC) | < 800 ms | PRD §9.E1 pass criteria |
| C3 | **Content correctness** (did the agent speak the segment we asked?) | ≥ 90 % token-overlap (Jaccard on tokens) OR human-judge OK | Required to make narration usable |
| C4 | **Cycle stability** | 4 / 5 consecutive cycles meet C1+C2+C3 | PRD §9.E1 "5 consecutive cycles all pass" relaxed to 4/5 since 5/5 is brittle for a Phase-3 scoring metric |

**Verdict logic** (applied on the held-out test set in Phase 5):

- If **exactly one arm** passes all criteria → ship that arm.
- If **multiple arms** pass → pick the one with lowest latency (interrupt + speak-start, summed), tie-break by content correctness.
- If **zero arms** pass → revisit the PRD. Option C (hybrid) becomes the next candidate; document the gap.

**Effect-size pre-registration:**

- Latency: any two arms within ±100 ms after measuring within-arm variance (≥2× variance floor) are **tied**; below that the gap is noise.
- Correctness: any arm below 90 % is **fail**, full stop. We don't ship a narration system that paraphrases the script.

---

## 0.6 Data Sources & Split

Synthetic test inputs (this is an API-behavior probe, not a customer-data classifier). All inputs are **pre-written narration segments** drawn from realistic content shapes the orchestrator will eventually produce.

| Set | Size | Examples | Use |
|---|---|---|---|
| **Train / scratch** | 10 rows | One-liners, weather chatter, "hello world" | Develop arms, debug instrumentation, eyeball outputs |
| **Dev** | 20 rows | 5 short (1 sentence), 10 mid (3-5 sentences, common case), 5 long (8+ sentences) | Phase 3-4 scoring + iteration |
| **Test (sealed)** | 15 rows | 5 short, 7 mid, 3 long — drawn from real paper + storybook content, not seen by any arm during Phase 3-4 | Phase 5 verdict, ONE pass only |

**Stratification:** equal short/mid/long ratios across dev and test so the verdict isn't biased by length. Each set also balances 5 categories of segment content:

- Pure exposition ("The third step is...")
- Question-bearing ("Why do you think they...") — tests TTS handling of question marks
- Numbers & symbols ("equation 3.4 with ε = 0.01")
- Quoted speech ('She said "no" and ran') — tests TTS quotation handling
- Long compound sentences (tests interrupt landing in middle of a clause)

**Hard rule:** train ↔ dev ↔ test rows are disjoint. Once a test row is read for any purpose other than the Phase-5 single pass, it moves to dev and a fresh test row is drawn.

---

## 0.7 Metric Definition (pre-registered, locked)

### Primary metric

**Composite pass-rate per arm**, computed per row, averaged across the set:

```
pass_rate(arm) = (# rows where C1 AND C2 AND C3 AND C4 all hold) / (total rows)
```

### Secondary metrics (informational, not used for ship/kill)

| Metric | Formula | Reason it's informational only |
|---|---|---|
| Mean interrupt latency | mean(interrupt_call_ts → silence_ts) | Aggregate hides variance; the primary uses per-row threshold |
| Mean speak-start latency | mean(speak_call_ts → first_audio_ts) | Same |
| Content-correctness rate | mean per row Jaccard-or-judge | Subsumed into C3 |
| LLM cost per cycle | dollars per /speak + /interrupt cycle (Gemini Flash $$ for Arm 2, Agora-resold for baseline + Arm 1 + Arm 3) | Cost is a tiebreaker, not a primary criterion for this experiment |

### How each criterion is measured

- **C1 (interrupt → silence)**: server records `interrupt_call_ts`. RTM client subscribed to the same channel records `agent_state_changed → idle` event → `silence_ts`. `silence_ts - interrupt_call_ts`. If the RTM event lags real audio, we add a cross-check via WebRTC audio energy in a headless Chromium tab (Phase 2 setup task).
- **C2 (speak-start)**: server records `speak_call_ts`. RTM client records `agent_state_changed → speaking` → `first_audio_ts`. Same cross-check via audio energy if RTM event lags.
- **C3 (content correctness)**: capture the transcript event over RTM (the agent's own TTS-output transcript). Compute Jaccard token overlap vs. the requested segment text. ≥ 0.9 = pass. Cross-judge sanity check: read 5 dev rows by eye; if Jaccard agrees with human "this is correct" on 5/5 we trust the metric.
- **C4 (cycle stability)**: run 5 speak→interrupt→speak cycles per row. Pass if ≥ 4 cycles satisfy C1+C2+C3.

### Variance baseline

Before Phase 4 diagnosis, run the **baseline alone three times same-prompt on the same dev set** (no code change between runs). Record mean ± stdev per criterion. This is the noise floor. Any arm-vs-baseline gap must be ≥ 2× stdev to count.

### Cross-judge sanity check

For C3 (content correctness): pick 5 dev rows. Score the arm output with both Jaccard (primary) and Gemini-2.5-Flash as a secondary judge ("Did the agent's spoken text match the requested narration text? Yes/No"). If Jaccard and Gemini agree on ≥ 4/5 rows, primary metric is trustworthy.

---

## 0.8 Instrumentation Plan (Phase 2 detail)

To collect timestamps deterministically without a live user:

1. **Test runner**: standalone Node.js script in `docs/experiments/2026-05-27-e1-agora-narration-control/runner/`.
2. **Agora session**: created via `agora-agent-server-sdk` from the runner.
3. **RTM event capture**: same script logs in to RTM with a generated user UID, subscribes to the same channel as the agent, and records `agent_state_changed`, `agent_metrics`, `transcript`, `agent_error` events with `Date.now()` timestamps.
4. **Optional Playwright audio-energy probe**: a headless Chromium tab joins the channel as a listener. JS in the page samples `analyserNode.getByteFrequencyData()` every 20ms and reports `audio_started_ts` / `audio_stopped_ts` via WebSocket back to the runner. Used to validate that RTM events agree with real audio onset; if they agree within 50ms we can drop the Playwright probe and trust RTM alone.
5. **Per-cycle output schema** dumped to `data.json`:

   ```json
   {
     "arm": "arm1_speak_inject",
     "row_id": "mid_007",
     "cycle": 3,
     "segment_text": "The third step is...",
     "speak_call_ts": 1779949000000,
     "first_audio_ts": 1779949000420,
     "transcript_emitted": "the third step is...",
     "interrupt_call_ts": 1779949004200,
     "silence_ts": 1779949004380,
     "c1_pass": true,
     "c2_pass": true,
     "c3_pass": true,
     "jaccard": 0.97,
     "cost_usd": 0.0003
   }
   ```

---

## 0.9 What This Experiment Does Not Settle

E1 does **not** decide:

- Q&A latency (E2's job)
- Mode-swap reliability across many turns (E3's job — though Arm 3 gets a small preview here)
- Resume-bridge timing (E4)
- Visual playhead sync (E5)
- Web SDK gaps (E6)

E1 settles **only** the architecture-lock question for narration control. The other PRD experiments stand on E1's verdict.

---

## 0.10 Out of Scope for This Experiment

- LLM choice optimization (Gemini vs. OpenAI for Q&A) — E2
- Multi-language narration (English-only for now)
- Voice cloning / custom MiniMax voices (use the working `English_captivating_female1` default; the `moss_audio_*` permission issue from session log applies here too)
- Long narration sessions (>5 min) — interrupt cycles tested are short bursts

---

## 0.11 Risks to the Experiment Itself

| Risk | Mitigation |
|---|---|
| Arm 2 (Gemini proxy) can't be triggered from a server-side script (needs a user turn to provoke LLM response) | If true, instrument Arm 2 via Playwright with a fake-audio mic stream; if that's also blocked, mark Arm 2 as "untestable via this harness" and document the gap |
| RTM `agent_state` events fire significantly after real audio (>100 ms) | Use the Playwright audio-energy probe as the source of truth; demote RTM events to secondary |
| Agora-resold MiniMax rate-limits aggressive `/speak` cycling | Insert ≥500 ms pause between cycles; document if rate-limiting forces longer pauses |
| Content of dev set leaks into training of baseline's LLM (gpt-4o-mini might have seen the paper text) | Use original-authored narration text where possible; for paper segments, paraphrase before adding to dev set |
| Within-arm variance is large enough that 2× threshold can't be met with 20 dev rows | Pre-register: if variance is unmanageable, expand dev set to 40 rows in Phase 3 (not test set — that stays sealed) |

---

## 0.12 Self-Audit Checklist (filled before Phase 5)

- [ ] Test set is sealed; ONE pass only at Phase 5
- [ ] Pre-registered metric + threshold; no metric drift after seeing scores
- [ ] Pilot run validated every metric field is populated before full dev run
- [ ] Distribution audit on dev set: per-length × per-category counts printed and checked
- [ ] Variance baseline measured (≥ 3 same-prompt reruns of baseline)
- [ ] Any winning gap is ≥ 2× variance, not just ≥ threshold
- [ ] Cross-judge sanity check on ≥ 5 rows for C3 with Gemini as second judge
- [ ] Each Phase-4 iter changed ONE thing only
- [ ] Iter hypotheses pre-written; falsification accepted as a finished iter
- [ ] ≤ 3 Phase-4 iterations
- [ ] Verdict locks LATEST hypothesis-driven iter, not best-scoring iter
- [ ] Per-category + per-length slice scores reported in addition to aggregate

---

---

## ADDENDUM 1 — Arm 3 deferred (added 2026-05-28, after Phase 3a pilot)

**Discovered:** Arm 3 (`session.update()` system-prompt-swap, then trigger speech) cannot be cleanly evaluated by this harness. The drive function I wrote calls `session.update({llm.system_messages: ...})` followed by `session.say(row.text, INTERRUPT)`. But **`session.say()` is a TTS-direct path** — it bypasses the LLM and reads the provided text verbatim. The system-prompt swap has no observable effect on what is spoken, because the LLM is never asked to generate.

**Why we can't fix Arm 3 in this harness:** Triggering "LLM-driven narration" requires sending a *user message* (chat or audio) to the agent so the LLM is invoked. The server SDK has no `sendUserMessage()` equivalent — incoming turns are voice-only via RTC. Faking a mic via Playwright with `--use-fake-device-for-media-stream` is doable but adds 4-8 hours of harness work and is exactly what E3 (mode-discipline experiment) is for.

**Decision:** Drop Arm 3 from E1. Compare baseline + Arm 1 + Arm 2 only. Document the deferral here and in the conclusion. E3 in the PRD remains the right experiment for "does Option B (LLM-driven narration via prompt swap) work with discipline?"

**Honest scoring note:** the Arm 3 pilot data file (`results-train-arm3.json`) shows 5/5 — but that is Arm 1's behavior in disguise. We do NOT include it in the dev-run scoring.

**Hypothesis update:** unchanged. H1 still predicts Arm 1 wins. The comparison now is Arm 1 vs Arm 2 vs baseline; the differentiator is whether routing through Gemini (vs OpenAI-resold) changes session-startup, say-call latency, or interrupt fidelity. Since both arms call `say()` which is TTS-direct, the LLM choice should have minimal effect on E1 criteria — Arm 2's distinction will come out in E2 (Q&A latency).

---

## 0.13 Files & Where They Live

```
docs/experiments/2026-05-27-e1-agora-narration-control/
├── frame.md                # this file (Phase 0)
├── data/
│   ├── train.json          # 10 scratch rows
│   ├── dev.json            # 20 scoring rows
│   ├── test.json           # 15 sealed rows
│   └── results.json        # filled by runner per arm
├── runner/                 # Phase 2 instrumentation
│   ├── runner.ts           # main harness (Node.js + agora-agent-server-sdk)
│   ├── rtm-probe.ts        # RTM event capture
│   ├── audio-probe.ts      # optional Playwright audio-energy probe
│   └── arms/
│       ├── baseline.ts     # native LLM-driven
│       ├── arm1_speak.ts   # /speak + /interrupt
│       ├── arm2_byok.ts    # Gemini proxy via app/api/chat/completions
│       └── arm3_update.ts  # /update system-prompt swap
├── charts/                 # PNGs rendered in Phase 3+5
├── scratch/                # ephemeral output during iteration
└── conclusion.md           # written at Phase 5
```

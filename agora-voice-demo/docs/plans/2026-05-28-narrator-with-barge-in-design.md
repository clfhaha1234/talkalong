# Design — Narrator + Barge-in Q&A + Graceful Resume

> **Status:** Approved. Ready for implementation plan.
> **Date:** 2026-05-28
> **Brainstormed via:** `superpowers:brainstorming` skill
> **Parent PRD:** [`../proactive-tutor-engine-prd.md`](../proactive-tutor-engine-prd.md) — v0.3, Option C (hybrid) architecture locked
> **Phase coverage:** PRD §10 Phase 3 + Phase 4 (barge-in + Q&A + graceful resume + incremental re-script)
> **Predecessors / Phase 1 baseline:**
> - `agora-voice-demo/lib/orchestrator/` — naive narrator (sleep-based), single-row session
> - `agora-voice-demo/app/api/tutor/start/route.ts` — SSE API
> - `agora-voice-demo/components/TutorPage.tsx` — listener-only browser client

## TL;DR

Build the proactive-narration + barge-in Q&A loop on top of Phase 1. Four locked decisions drive the design:

| Decision | Pick | Architectural implication |
|---|---|---|
| Main-line micro-adjustment scope after Q&A | **档 3 — dynamic rewrite of next 1-2 segments** | Server has a `rescript` LLM call that runs on every resume |
| End-of-QA detection | **D — silence timer + AI confirm after Nth turn** | Browser owns silence timer; server owns confirm prompt injection |
| Bridge line strategy | **II — LLM-generated each time** | Server runs a `bridge` LLM call in parallel with `rescript` |
| Architecture split (state machine + LLM home) | **C — split: server owns state + LLM, browser owns RTM events + UI** | Server stays pure backend; browser reuses existing `AgoraVoiceAI` toolkit |

Bridge LLM finishes first (~500ms), starts playing immediately (~4-6s of speech). Rewrite LLM finishes a few hundred ms later — its output is queued via `APPEND` and arrives in time to seamlessly follow the bridge. Net result: **dead air after Q&A is < 1 second**.

---

## 1. Components & Boundaries

### 1.1 Server modules (extend `agora-voice-demo/lib/orchestrator/`)

| File | New / Extend | Responsibility |
|---|---|---|
| `state-machine.ts` | **NEW** | Outer FSM `IDLE / MAIN / BRANCH / DONE` + inner FSMs. Transition table. Single source of truth for "where in the loop are we." |
| `progress-state.ts` | EXTEND | Add `branch_line` (PRD §5.2) + `comprehension_signal` fields. Already has `enterMain()` / `startSegment()` / `completeSegment()`; add `enterBranch()` / `exitBranch()`. |
| `narrator.ts` | **REPLACE** | Remove `sleep(approx_duration)`. Push all segments via `say({priority: 'APPEND'})` and let Agora queue them. React to state-machine events for progress emission. |
| `barge-in-scheduler.ts` | **NEW** | `classify(question, remaining_segments) → 'answer_now' \| 'defer_to_segment' \| 'dismiss_gently'`. Phase 3 ships `answer_now` only; the other two are no-ops returning `answer_now`. |
| `bridge.ts` | **NEW** | LLM call. Input: last 2 Q&A turns + paused segment id + start of next original segment. Output: 4-6 second connector speech. |
| `rescript.ts` | **NEW** | LLM call. Input: original next 1-2 segments + Q&A history + comprehension signal. Output: rewritten next 1-2 segments. |
| `comprehension-tracker.ts` | **NEW** | Accumulates Q&A signal: follow-up depth, was the question close to an upcoming segment, etc. Feeds `rescript`. Demo flips a depth dial once. |
| `index.ts` | EXTEND | Export `handleQaEnded(handle, qa_history)` orchestrator method. |

### 1.2 Server API routes (extend `agora-voice-demo/app/api/`)

| Route | New / Extend | Purpose |
|---|---|---|
| `POST /api/tutor/start` | EXTEND | Already exists. Add `branch_started` / `branch_ended` events to SSE stream. Bake Agora pipeline config (filler_words, turn_detection, RTM flags) into the agent creation. |
| `POST /api/tutor/qa-ended` | **NEW** | Body: `{ session_id, qa_history, paused_segment_id }`. Triggers parallel `bridge` + `rescript` LLM calls; pushes results via `session.say()`. Returns 202 (work continues; the user perceives the result via audio + SSE). |
| `POST /api/tutor/stop` | **NEW** | Graceful stop. Server-side cleanup. |

### 1.3 Browser components (extend `agora-voice-demo/components/TutorPage.tsx`)

| Change | Notes |
|---|---|
| Import `AgoraVoiceAI` from `agora-agent-client-toolkit` | Wraps `agora-rtm` so we get typed `AGENT_STATE_CHANGED`, `TRANSCRIPT_UPDATED`, `AGENT_METRICS`, `AGENT_ERROR`, `AGENT_INTERRUPTED`. Pattern already in `components/ConversationComponent.tsx:235-242`. |
| Publish a local microphone track | Phase 1 was a listener only. To barge in, browser must publish. Use `agora-rtc-react`'s `useLocalMicrophoneTrack` + `usePublish` (same as `ConversationComponent.tsx`). Gated behind StrictMode `isReady` guard (Phase 1 pattern in AGENTS.md). |
| End-of-QA detector | Browser-side timer on `AGENT_STATE_CHANGED`. SPEAKING→IDLE starts a 2 s countdown; speech from user (SPEAKING by local UID) resets it. Timer expiry → `POST /qa-ended`. |
| `qa_turn_count` tracking | Increment on each SPEAKING→IDLE for the agent within a BRANCH episode. At count == 3, server's confirm path takes over. |
| Outer-state mirror | Browser mirrors `outer_state` from SSE snapshots; does NOT make decisions. |
| Transcript + QA panel | Render `TRANSCRIPT_UPDATED` events for user + agent turns during BRANCH. |
| Comprehension dial UI | A small indicator (deeper / default / simpler) updates when server emits comprehension change. |

### 1.4 Agora session config (one-time, in `lib/orchestrator/index.ts` agent build)

**Task 0 finding (2026-05-28):** `Agent` class exposes typed builders for every Phase 3 Properties field. No casts, no raw API.

```typescript
new Agent({ name, instructions, greeting })
  .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
  .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
  .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: 'English_captivating_female1' }))
  .withFillerWords({
    enable: true,
    trigger: { mode: 'fixed_time', fixed_time_config: { response_wait_ms: 800 } },
    content: {
      mode: 'static',
      static_config: {
        phrases: ['Hmm.', 'Let me see.', 'One sec.'],
        selection_rule: 'shuffle',
      },
    },
  })
  .withTurnDetection({
    config: {
      start_of_speech: { mode: 'vad' },
      end_of_speech: { mode: 'semantic' },
    },
  })
  .withAdvancedFeatures({ enable_rtm: true })
  .withParameters({
    data_channel: 'rtm',
    enable_metrics: true,
    enable_error_message: true,
  });
```

`agent.createSession(...)` keeps its Phase 1 shape (channel / agentUid / remoteUids / idleTimeout / expiresIn). All Phase 3 config lives on the `Agent` object pre-build.

Field names follow the actual SDK schema, NOT the more abbreviated forms that appeared in v1 of this design (which used `type`/`config`/`utterances`/`delay_ms` — those were wrong; the real schema uses `mode`/`fixed_time_config`/`phrases`/`response_wait_ms`).

---

## 2. State Machine

```
Outer:
  ┌────┐ start ┌──────┐ all_done ┌──────┐
  │IDLE├──────►│ MAIN ├──────────►│ DONE │
  └────┘       └──┬──┬┘           └──────┘
                  │  ▲
                  │  │ resume_complete
       barge_in   ▼  │
              ┌──────┴──┐
              │ BRANCH  │
              └─────────┘

Inner (MAIN):       BETWEEN_SEGMENTS → SPEAKING → BETWEEN_SEGMENTS → ...
Inner (BRANCH):     AGENT_ANSWERING → WAITING_FOR_USER → DETECTING_END
```

### 2.1 Transition table

| From | Event | To | Side effects |
|---|---|---|---|
| IDLE | session.start | MAIN | Push s1 via `say(APPEND)`; emit `session_started` to SSE |
| MAIN | RTM agent_state SPEAKING→LISTENING (i.e. user spoke) | BRANCH | Record `paused_segment_id`; set `qa_turn_count = 0`; emit `branch_started` |
| BRANCH (AGENT_ANSWERING) | RTM agent_state SPEAKING→IDLE | BRANCH (WAITING_FOR_USER) | Start 2s silence timer in browser; increment `qa_turn_count` |
| BRANCH (WAITING_FOR_USER) | timer expires AND `qa_turn_count ≤ 2` | BRANCH (RESUMING) | Browser POST `/qa-ended` |
| BRANCH (WAITING_FOR_USER) | timer expires AND `qa_turn_count == 3` | BRANCH (DETECTING_END) | Server `session.say('Got it — keep going?', INTERRUPT)`; restart timer after agent finishes |
| BRANCH (DETECTING_END) | user says "yes" / similar OR silence > 2s | BRANCH (RESUMING) | Browser POST `/qa-ended` |
| BRANCH (RESUMING) | server completes bridge+rescript and pushes | MAIN | Emit `bridge_started`, `bridge_completed`, then per-segment `segment_started` for rewritten segments |
| MAIN | all segments emitted segment_completed | DONE | `session.stop()`; emit `narration_complete` |
| BRANCH | user goes silent for > 15s with no prior QA activity | (ignore — treat as user listening) | No-op |
| ANY | RTM error / session error | ERROR | Emit `error` to SSE; cleanup |

### 2.2 Who emits which event

| Event source | Events |
|---|---|
| Browser → Server (POST) | `qa-ended` only. Browser does not POST per-turn. |
| Server → Browser (SSE) | All `snapshot` updates, plus `branch_started`, `branch_ended`, `bridge_started`, `bridge_completed`, `segment_started`, `segment_completed`, `comprehension_changed`, `narration_complete`, `error` |
| Agora → Browser (RTM) | `AGENT_STATE_CHANGED`, `TRANSCRIPT_UPDATED`, `AGENT_METRICS`, `AGENT_INTERRUPTED`, `AGENT_ERROR` |

---

## 3. Data flow — one complete barge-in → resume

```
T+0ms       Narration segment s3 playing (Agora TTS audio in RTC channel)
            outer=MAIN, current_segment_id=s3

T+1200ms    User speaks: "Wait — why did they prune at inference time?"

T+1250ms    Agora detects start_of_speech (VAD)
            Agora auto-interrupts TTS playback
            RTM AGENT_STATE_CHANGED: SPEAKING → LISTENING

T+1260ms    Browser captures RTM event
            Sets local mirror outer=BRANCH; sends "branch_starting" intent over SSE poll
            (Actually: browser does NOT need to ping server here. Server learns of
            BRANCH transition from its own RTM subscription, OR from a single ping
            we'll send to /qa-ended at the end. For the demo we keep this simple:
            server only learns BRANCH on the /qa-ended ping. State during BRANCH is
            "browser sees, server doesn't care.")

T+1500ms    Agora ASR completes final transcript
            FillerWords may play "Hmm." here if LLM TTFT > 800ms

T+2000ms    Agora LLM (gpt-4o-mini) produces first token (~500ms TTFT)
T+2200ms    Agora TTS produces first audio chunk (TTS TTFB ~200ms)
T+2200ms    Agent audio: "Inference time — they keep the full model but mask
                          the heads. Good question to ask now…"

T+5500ms    Agent audio ends
            RTM AGENT_STATE_CHANGED: SPEAKING → IDLE
            Browser starts 2 s silence timer
            qa_turn_count = 1

T+7500ms    Silence timer expires (user didn't follow up)
            qa_turn_count (1) ≤ 2 → POST /api/tutor/qa-ended
            Body: { session_id, qa_history: [user_q, agent_a],
                     paused_segment_id: 's3' }

T+7510ms    Server receives /qa-ended. In parallel:
            ├─► bridge LLM (Gemini 2.5 Flash Lite, ~500ms)
            │     prompt: "We were at segment s3 about Y. User asked about X.
            │              You answered X. Write a 4-6 second connector that
            │              acknowledges X then re-orients to where we were."
            │
            └─► rescript LLM (Gemini 2.5 Flash Lite, ~800ms)
                  prompt: "Original segments s4 and s5: [text]. The user asked
                           about X. Rewrite s4 and s5 with awareness of X;
                           keep core content intact but reference the question
                           where natural."

T+8010ms    Bridge returns first.
            Server: session.say(bridge_text, { priority: 'INTERRUPT' })
            Server: emit SSE bridge_started

T+8200ms    Bridge audio starts in RTC channel (~190ms server→Agora→TTS)
            Estimated bridge duration: ~4500ms

T+8310ms    Rescript returns.
            Server: session.say(rewritten_s4, { priority: 'APPEND' })
            Server: session.say(rewritten_s5, { priority: 'APPEND' })
            (These queue behind bridge; Agora plays seamlessly)
            Server: emit SSE bridge_completed (will fire ~4.3s later when Agora
                    transitions; we estimate optimistically here)

T+12700ms   Bridge audio completes (~4500ms after T+8200)
            Agora pulls rewritten_s4 from queue, starts playing immediately
            RTM AGENT_STATE_CHANGED: BRIEF SPEAKING gap (~50ms) between bridge
            and s4'
            Server (or browser via RTM) emits segment_started s4'

T+12700ms+  Continues main line with s4', s5', s6 (original), s7 (original)...

NET DEAD AIR after Q&A answer ends (T+5500) to bridge starts (T+8200): ~2.7s,
of which 2s is the intentional silence timer (giving the user a chance to
follow up) and ~700ms is the unavoidable bridge LLM call.

Of that 700ms, FillerWords cannot cover (it's before bridge plays). However:
the silence is right after the agent's own answer, and a teacher pausing for a
second to gather thought after answering a question is natural — not awkward.
If user testing finds it awkward, options: shorten timer to 1s, or have server
fire a "thinking" filler at T+7500.
```

### 3.1 Latency budget summary

| Phase | Span | Budget | Mitigation if exceeded |
|---|---|---|---|
| barge-in detect | 0-100ms after user speaks | (Agora-internal) | None — Agora controls |
| Q&A pipeline (ASR + LLM + TTS first audio) | ~950ms | FillerWords masks 800ms+ delay | Agora-managed; configurable |
| End-of-QA detection | 2000ms intentional silence | (the silence IS the UX) | Tune via `silence_timer_ms` |
| Resume bridge generation | 500-700ms | bridge ≥ rescript runtime in flight | Pre-written bridge fallback (§4) |
| Total dead air after Q&A | < 1000ms beyond the silence | bridge LLM kept on Gemini Flash Lite | Cache short bridge templates |

---

## 4. Error handling

| Failure | Detection | Fallback |
|---|---|---|
| Bridge LLM > 1500ms / errors | Timeout watchdog on the Promise | Pick random from 10-item pre-written library; log `bridge_fallback_used`. Library lives in `lib/orchestrator/bridge-library.ts`. |
| Rescript LLM > 3500ms (bridge will run out) | Watchdog | Use original next segments (no rewrite). Bridge already played; transition is still smooth. Log `rescript_fallback_used`. |
| Both LLMs fail | Both watchdogs fire | Fall through to pre-written bridge + original segments. Always recoverable. |
| RTM disconnect during BRANCH | `AgoraVoiceAI` toolkit emits `error` event | Toolkit auto-reconnects; if >5s, browser shows degraded banner; if >10s, abort session |
| User QA off-topic in storybook | `barge-in-scheduler.classify` returns `dismiss_gently` (post-Phase 3 — for Phase 3 we ship `answer_now` only) | Agent answers softly, redirects; browser still POSTs `/qa-ended` after silence timer |
| QA exceeds 3 turns and confirm-prompt also gets ignored | Server tracks `qa_turn_count`; on 4th turn with no progress | Server forces resume with notice: "We'll come back to that — keep going for now" |
| Agora session expires (>20min) | `AgentSession` returns `FAILED` state via RTM | Save progress state to a transient store; UI offers "continue from segment N" button; new session starts with `paused_segment_id = N` |
| User speech mis-classified as barge-in (e.g. coughing) | qa_history shows empty or noise transcript | Treat the QA turn as if it never happened; immediately POST `/qa-ended` (qa_turn_count = 0); server skips rescript, just plays a `ping`-back bridge |

---

## 5. Testing strategy

### 5.1 Layer 1 — Unit tests (no Agora, CI-runnable)

| Module | Tests |
|---|---|
| `state-machine.ts` | `transition(state, event)` over full table; reject undefined transitions |
| `barge-in-scheduler.ts` | `classify` with: (a) question close to next segment → `defer`; (b) question on covered material → `answer_now`; (c) question off-topic → `dismiss_gently` |
| `bridge.ts` | Mock LLM with sync stub; verify prompt construction; verify timeout-watchdog fallback fires |
| `rescript.ts` | Same shape; mock LLM; verify prompt contains qa_history + comprehension hints |
| `comprehension-tracker.ts` | Synthetic turn streams: 3 correct answers → "deeper"; 1 correct + 2 silence → "simpler" |
| `splitter.ts` | (already covered by Phase 1) |

### 5.2 Layer 2 — Integration loop test (real Agora, no browser)

`scripts/e2/barge-in-loop.ts`:
- Lifts `scripts/e1/cycle.ts` patterns: session lifecycle, getTurns() analytics
- Step 1: Start session with full Phase 3 config (filler_words, turn_detection, RTM flags)
- Step 2: `session.say(segment_1_long)` — start narration
- Step 3: After 2 s, programmatically inject "user audio":
  - Path A (preferred): Playwright with `--use-fake-device-for-media-stream` + WAV file
  - Path B (cheap): if Playwright path is blocked, mock the BRANCH transition by directly calling `/api/tutor/qa-ended` and skip the real barge-in test
- Step 4: Listen to RTM event sequence; assert ordering: SPEAKING (s1) → LISTENING → SPEAKING (answer) → IDLE
- Step 5: Auto-fire POST `/qa-ended` after observed IDLE
- Step 6: Validate bridge + rescript both fire; final RTM SPEAKING gap between bridge-end and segment-2-start < 200 ms
- **Pass criteria** (per PRD §9 E4):
  - Total dead air from agent answer end to bridge start: **< 1200 ms** (silence_timer + bridge LLM)
  - Bridge → segment 2 seam: **< 200 ms**
  - 5 of 5 trials pass

### 5.3 Layer 3 — Browser manual / Playwright acceptance

`scripts/e3-acceptance.ts`:
- Drives Playwright as in Phase 1's smoke test
- Loads `/tutor` with a known paper passage
- Mid-narration, plays a pre-recorded question through the fake mic
- Asserts the DOM shows the BRANCH state, QA panel populates, then RESUMING state, then back to MAIN with the next segment-card text *different from the original* (proves rescript ran)
- Assertion: no console errors; total page elapsed time matches expectation

---

## 6. Open questions for the writing-plans skill

These are tactical decisions that the implementation plan should call out explicitly:

1. **Agora session config plumbing.** The SDK's typed `AgentSessionOptions` does NOT directly expose `filler_words`, `turn_detection`, `advanced_features`, `parameters.data_channel`. We need to verify the right plumbing path:
   - Builder methods on `Agent` (`withAdvancedFeatures(...)`?)
   - Direct `session.raw` REST passthrough
   - `session.update()` after start
   Implementation plan should start with a 30-min probe to confirm the path.
2. **Where to host the bridge LLM call.** Two options:
   - Same `agora-agent-server-sdk` `Gemini` instance attached to the agent (mutually exclusive with the Q&A LLM choice — would conflict with Agora-resold OpenAI)
   - Direct Gemini API call from server, separate from the agent's pipeline
   Option (b) is cleaner; pick that unless the probe reveals issues.
3. **Bridge LLM prompt design.** The bridge needs to: (a) reference the Q&A topic in 1 sentence, (b) re-orient to where we were in 1 sentence, (c) be 60-80 chars to give Agora-managed TTS room to play ~4-5 s. Implementation plan ships a v1 prompt; iterate based on Layer 3 testing.
4. **Comprehension signal feeding.** What exactly do we pass to rescript? Minimum viable: last 2 Q&A turns + a single `depth: 'deeper' | 'default' | 'simpler'` enum. Defer richer signals to Phase 5 (elicitation).
5. **Per-row session restart from E1.** Phase 1 currently runs all rows in one session. With BRANCH + resume, sessions can grow. The implementation plan should keep the safe per-row-session pattern from E1, OR explicitly note the trade-off and how to monitor for the ~40 api_speak ceiling.

---

## 7. What this design DOES NOT cover (future phases)

- **Phase 5 — Proactive elicitation nodes** (pre-planted "what do you think happens next?" questions). The data structure (`Segment.elicitation_node`) is already in place; the trigger logic is deferred.
- **Phase 6 — Visual layer** (Remotion-rendered illustrations synchronized to segments). The `ProgressSnapshot` has a `visual` field slot reserved; the integration is deferred.
- **Phase 7 — Storybook content + persona swap.** No code changes needed for swap; only different system prompts and segment style. Out of scope here.
- **Multi-user / classroom mode.** Hard out per PRD §2.2.
- **Cross-session memory.** Hard out per PRD §2.2.

---

## 8. Reference index

| File | Why it matters |
|---|---|
| `agora-voice-demo/docs/proactive-tutor-engine-prd.md` (v0.3) | Parent PRD — architecture and rationale |
| `agora-voice-demo/docs/experiments/2026-05-27-e1-agora-narration-control/conclusion.md` | Locks `session.say()` + per-row sessions + 98.7 % pass-rate |
| `agora-voice-demo/docs/experiments/2026-05-28-e1.5-gemini-model-pick/conclusion.md` | Locks `gemini-3.1-flash-lite` + `reasoning_effort='minimal'` for bridge + rescript |
| `agora-voice-demo/scripts/e1/cycle.ts` | Reference pattern for session lifecycle + turn analytics |
| `agora-voice-demo/components/ConversationComponent.tsx:235-242` | Pattern for browser-side RTM event subscription via `AgoraVoiceAI` |
| `agora-voice-demo/lib/orchestrator/` | Phase 1 baseline to extend |
| `agora-voice-demo/app/api/invite-agent/route.ts` | Working Agora session config reference (LLM, TTS, STT vendors; agent UID) |

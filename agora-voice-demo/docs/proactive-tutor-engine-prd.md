# Proactive Tutor Engine — PRD v0.3 (Architecture Locked)

> **For Claude:** PRD with locked architecture decision. Phase-0 experiment data backs the lock — see [`docs/experiments/2026-05-27-e1-agora-narration-control/conclusion.md`](experiments/2026-05-27-e1-agora-narration-control/conclusion.md) for the verdict. Implementation can begin from §10.
>
> **Predecessors:** Supersedes [`legacy/proactive-tutor-engine-prd-v0.1.md`](legacy/proactive-tutor-engine-prd-v0.1.md) (originally `proactive_engine_README.md` at repo root) and an interim v0.2 (which reopened the architecture question). v0.3 locks it.

**Working name:** Talkthrough
**One-liner:** Turn any reading material into a living tutor that *proactively narrates with illustrations and video*, can be *interrupted mid-sentence for real-time voice Q&A*, and *gracefully resumes* without losing its place.
**Doc type:** Hackathon-grade PRD with experiment-backed architecture lock
**Author:** Lifei
**Status:** **v0.3 — architecture LOCKED (Option C — hybrid)** based on E1 verdict
**Date:** 2026-05-28

## v0.3 — What changed since v0.2

| Section | Change |
|---|---|
| §0 (TL;DR) | Architecture lock summarized at the top |
| §4 | Option C (hybrid) is the chosen architecture. v0.2's three-way comparison is preserved for historical context but A and B are clearly marked NOT CHOSEN. |
| §9 | E1 result added (arm1 wins, 98.7 % test-set pass-rate, latency tiebreaker). E2 & E3 explicitly deferred with rationale (require mic simulation; ~4-8 h of new harness work). |
| §11 | **ADR populated** with the verdict, evidence, trade-offs, and reversibility cost |
| §10 (build plan) | Phase 0 marked done. Phase 1+ unchanged from v0.2, now ready to execute. |
| §12 (risks) | R3 (Option B mode-discipline failing) becomes lower priority since narration is locked to direct text-injection — Option B is no longer required for narration. |

---

---

## 0. TL;DR

We're building the **orchestration brain** of a proactive AI teacher. It owns:

1. The lesson plan (`main_line` script — segmented, paced, with pre-planted elicitation questions).
2. The conversation state (where am I, what's covered, did the user understand).
3. The interrupt-and-resume choreography (`branch_line` Q&A, then back to `main_line` with a bridge).
4. The visual layer's playhead (which illustration / Remotion clip is on screen now, and what gets paused when the user barges in).

We **rent**, not build:

- ASR + LLM + TTS pipeline and barge-in detection from **Agora Conversational AI Engine**.
- Illustration-to-video animation from the existing **talkalong Remotion pipeline** (`video_story_README.md`).

### Architecture lock (decided in E1, 2026-05-28)

> **Option C (hybrid) wins:**
>
> - **Narration** is delivered by the orchestrator via `session.say(text, INTERRUPT)`. Bypasses Agora's LLM entirely — TTS reads the orchestrator's segment text byte-for-byte. **E1 confirmed: 98.7 % pass on sealed test, C1 mean 213 ms, C2 mean 192 ms, max C1 = 375 ms.** Locked.
> - **Q&A** stays on Agora's native LLM loop (Deepgram → OpenAI gpt-4o-mini → MiniMax). User audio → Agora ASR → LLM → TTS, no orchestrator detour. This is exactly the user's framing: *"agora 主要是传话的和QA的"*.
> - **Per-row session restart** is part of the pattern: one Agora session per content row (~5 narration segments) to stay well under the implicit ~40-turn-per-session ceiling discovered in E1 Phase 4.
> - **LLM provider for Q&A** is the one open dial — Agora-resold OpenAI gpt-4o-mini for the demo (no key management, lowest tail latency in E1); BYOK Gemini 2.5 Flash is supported as a drop-in via the existing `app/api/chat/completions/route.ts` proxy when cost or model-control matters. Picking between the two at scale is E2.

What this lock does NOT settle (deferred to follow-up experiments):

- Whether Gemini 2.5 Flash's Q&A latency matches OpenAI gpt-4o-mini once routed through the BYOK proxy ([E2](#9-phase-0--experiments-required-before-architecture-lock))
- Whether Agora's `/update`-based mode swap is reliable enough to be a backup path ([E3](#9-phase-0--experiments-required-before-architecture-lock))
- Visual ↔ narration sync tolerance ([E5](#9-phase-0--experiments-required-before-architecture-lock))

These are no longer architecture-lock questions — Option C is the architecture. They're optimization questions.

---

## 1. Why This Product

### 1.1 The gap

Every "AI explainer" today is **reactive**: the user has to know what to ask. A good human teacher is **proactive**: they have a lesson plan, drive it, pause to check understanding, accept interruptions, and pick the thread back up. That second mode is what unlocks "the AI as a tutor" rather than "the AI as a search box with a voice."

### 1.2 What's defensible

Not the speech I/O. Not the rendering. The **scheduling layer**:

- Knowing *when* to stop and ask.
- Knowing *whether* an interruption is "answer now" or "good question, I'll get there."
- Knowing *when a Q&A digression is done* so the resume feels natural.
- Knowing *whether the user actually got it* (and adjusting the rest of the lesson accordingly).

These are the four signals that separate a polished tutor from "TTS reading a script with a chat button."

### 1.3 First content types (hackathon scope)

| | **A. Paper / long-form** (primary build target) | **B. Storybook** (secondary, reuse-proof) |
|---|---|---|
| User | Student, researcher, self-learner | Child + parent (co-listening) |
| Persona | Sharp, encouraging research mentor | Warm, playful storyteller |
| Why it ships first | Clearest main-line structure; strongest "wow" on resume | Pairs naturally with the existing Remotion illustration pipeline; high demo virality |

Same engine, swap only `{structuring_prompt, persona_prompt, elicitation_templates, visual_pipeline}`.

---

## 2. Product Scope

### 2.1 In scope (hackathon)

- End-to-end loop on **one** real paper + **one** real storybook
- Voice narration with the Agora Convo-AI Engine
- Synchronized **visual layer**: static illustration per segment for Scenario B (storybook), and key-figure render-on-segment for Scenario A (paper)
- Barge-in → Q&A → resume with bridge line
- At least **one** proactive elicitation node fires and branches on user response
- Demo-able comprehension signal: tutor adjusts depth based on whether the user answered the elicitation correctly

### 2.2 Out of scope (post-hackathon)

- Multi-user / classroom mode
- Accounts, payments, cross-session memory
- "Any content type" generalization (we *design for it* but only wire two)
- Mobile-native client if Agora Web SDK is viable for the demo
- Custom voice cloning / fine-tuned LLMs

### 2.3 Hard non-goals

- Don't build our own ASR/TTS — we will lose
- Don't build our own video renderer — `video_story_README.md`'s Remotion pipeline is the substrate
- Don't try to make resume work on long, multi-question Q&A digressions for the demo — the first hard case is "one interrupt, one answer, one resume"

---

## 3. The User Experience (what good looks like)

A user pastes a paper PDF (or picks a storybook). After ~10s of preparation (script-segmenting + first illustration), the tutor speaks:

> *"Okay — this paper is about transformer compression. The authors are betting that you can prune 30% of attention heads with almost no loss. Let me walk you through how they got there."*

[Illustration of the paper's headline figure fades in. The tutor continues talking, gesturing through the figure as it animates via Remotion.]

The user cuts in mid-sentence:

> "Wait — pruning attention heads, like permanently or just at inference time?"

The tutor stops *immediately* (the visual freezes on the current frame), pauses ~600ms (think beat), and answers in persona:

> *"Inference time — they keep the full model but mask the heads. Good question to ask now though, because it matters for what they measure next. Want me to keep going?"*

User: "Yeah."

Bridge:

> *"Right — so they ran their pruning on three benchmarks…"*

[Visual resumes from the exact frame it paused on; narration picks up cleanly from the segment break.]

A minute later, the tutor reaches a pre-planted elicitation node:

> *"Quick check — why do you think they got better results on language tasks than vision?"*

If the user answers correctly: tutor confirms and moves to a deeper next segment.
If the user says "I don't know" / silence: tutor offers the answer + simpler next segment.
If wrong: tutor gently corrects, then moves on at the same depth.

**That's the demo.** The hard parts are everything between "user speaks" and "narration resumes."

---

## 4. Architecture — Two Options, Decided in Phase 0

Both options share the same outer shape. They differ in **who owns the conversation LLM** and **what flows over the Agora channel**.

### 4.1 Shared shape

```
                              ┌──────────────────────────────────┐
   Content (PDF / story) ──►  │ STRUCTURING LAYER (offline-ish)  │
                              │  - segments into narration chunks │
                              │  - tags cognitive nodes           │
                              │  - plans elicitation questions    │
                              │  - emits initial main_line state  │
                              └────────────┬──────────────────────┘
                                           │
                              ┌────────────▼──────────────────────┐
                              │ ORCHESTRATOR (our moat)           │
                              │  - dual state machine             │
                              │  - barge-in scheduling            │
                              │  - resume + incremental re-script │
                              │  - comprehension tracker          │
                              │  - visual playhead control        │
                              └──┬─────────────────────────┬──────┘
                                 │                          │
                          control │                          │ control
                                 │                          │
              ┌──────────────────▼─────────┐    ┌──────────▼───────────────┐
              │ AGORA CONVOAI ENGINE       │    │ VISUAL LAYER             │
              │  (rented voice I/O)        │    │  (Remotion pipeline from │
              │  - ASR / barge-in detect   │    │   video_story_README.md) │
              │  - LLM (config-dependent)  │    │  - per-segment clip      │
              │  - TTS                     │    │  - pause/resume on burge │
              └────────────────────────────┘    └──────────────────────────┘
```

### 4.2 Option A — "Agora is the mouth only" (script-injection model)

Our orchestrator owns the entire conversation LLM. Agora is essentially a managed STT + TTS + barge-in detector with an LLM that we keep on a very short leash.

| Component | Owner | What it does |
|---|---|---|
| Script content | Our orchestrator | Generates segment text, decides what to say next |
| What Agora says | Our orchestrator | Pushes each segment via `POST /agents/{id}/speak` or v2.6 text-injection |
| LLM behind Agora | Configured but minimal | Only used for Q&A turns; we feed it system prompt + context per call, or proxy it through our backend via the BYOK custom LLM endpoint (`/api/chat/completions` already exists in the cloned quickstart) |
| Q&A answer | Our orchestrator's LLM call → push answer text to Agora via `/speak` | Single source of truth |
| Resume | Orchestrator decides + pushes bridge line via `/speak`, then next segment | Tight control |

**Pros:**

- One source of truth for state. Our progress object, our memory, our LLM call.
- Easy to do non-LLM things in-flow: insert silence, sync to visual playhead, gate on comprehension tracker.
- Easy to make narration mode and Q&A mode behave differently (different model, different temperature, different memory shape).
- Dynamic script mutation is trivial: we just push different text on the next `/speak`.

**Cons:**

- Two LLM round-trips for a Q&A turn (Agora ASR → our LLM → Agora TTS). Latency budget tighter.
- We re-implement parts of what Agora's pipeline already does (turn detection coordination, prompt threading).
- We don't benefit from any Agora-side "smart" behavior in QA mode.

**Where the BYOK custom-LLM endpoint fits:** the cloned quickstart already includes `app/api/chat/completions/route.ts` — an OpenAI-compatible SSE proxy. In Option A, we point Agora's LLM config to that proxy. Every QA turn comes through our server. We can swap the prompt, inject memory, or run a smaller model for low-priority chatter all without restarting the session.

### 4.3 Option B — "Agora is mouth + Q&A brain" (system-prompt-swap model)

Agora's LLM does both narration and Q&A. Our orchestrator nudges modes by swapping the system prompt via `POST /agents/{id}/update`.

| Component | Owner | What it does |
|---|---|---|
| Script content | Our orchestrator | Still segments; passes the segment text as a "narrate this next" instruction in the system prompt |
| What Agora says | Agora's LLM | Reads the instruction, generates the narration, speaks it |
| LLM behind Agora | Full agent loop | Holds the conversation including Q&A turns |
| Q&A answer | Agora's LLM | Uses its own short-term memory + the swapped system prompt |
| Resume | Orchestrator does `/update` to push next-segment instruction + bridge | Trust Agora to use it |

**Pros:**

- Fewer round-trips. ASR → LLM → TTS all happen inside Agora; latency advantage especially for Q&A.
- Naturally exploits any Agora-side improvements over time (turn detection, prompt caching, etc.).
- Less code on our side.

**Cons:**

- `POST /agents/{id}/update` **overwrites `params` entirely** per ConvoAI docs — every update is a complete object. Easy to nuke state by accident.
- Agora's LLM holds the conversation memory. Hard to deterministically force "say exactly this next" vs. "respond freely now." Tutor may drift.
- Harder to gate narration on our comprehension tracker — we'd have to encode it back into the system prompt and trust the LLM to follow.
- Dynamic script mutation = updating the system prompt, which means trusting the LLM to read the new instruction *next turn*, not mid-turn. Resume bridge feels fragile.

### 4.4 Hybrid — "Agora QA, orchestrator narration" (Option C, only if Phase 0 demands it)

If Phase 0 shows Option A's latency for Q&A is unacceptable but Option B's mode-discipline is unworkable:

- Narration goes through the orchestrator as in A (text-injection / `/speak`).
- Q&A turns are handled inside Agora's LLM, with the system prompt narrowed to "answer the user's question in persona, then say END_OF_QA when they seem satisfied."
- Orchestrator listens via RTM for `END_OF_QA` and triggers resume.

This is more code than either A or B, so we don't choose it unless we have to.

### 4.5 Decision criteria (settled by Phase 0)

We pick the option that wins on:

1. **Q&A latency** — does the answer start <1.0s after the user stops talking?
2. **Resume crispness** — does the tutor pick up the right segment with the right bridge, every time, with no drift?
3. **Script-mutation flexibility** — can we change the next segment's content mid-session and have it spoken correctly?

§9 specifies the experiments. §11 records the answer.

### 4.6 Decision (locked v0.3) — Option C (hybrid)

**Option C wins.** Implementation profile:

```
ORCHESTRATOR (our code)                 AGORA CONVOAI (rented)
─────────────────────────              ──────────────────────────
                                       Per-row session (started fresh
                                       per content row):
1. Generate next segment text          ┌──────────────────────────┐
   from main_line state         ──►   │ session.say(text, INTERRUPT)  │  ◄── arm1 winner
                                       │  → TTS reads text verbatim   │
                                       │  → C1 < 300ms, C2 < 800ms    │
                                       └──────────────────────────┘
                                              │
                                              ▼ if user starts speaking
                                       ┌──────────────────────────┐
                                       │ Agora auto-interrupts TTS    │
                                       │ ASR transcribes user voice   │
                                       │ LLM (gpt-4o-mini) answers in │
                                       │   persona via system prompt  │
                                       │ TTS reads LLM's answer       │
                                       └──────────────────────────┘
                                              │
                                              ▼ when agent returns to IDLE/LISTENING
2. Detect end-of-QA via RTM events,    ┌──────────────────────────┐
   set BRANCH → MAIN transition,       │ session.say(bridge_line,     │
   emit bridge_line                ──► │   INTERRUPT)                 │
                                       │ session.say(next_segment,    │
3. Continue main_line                  │   INTERRUPT)                 │
                                       └──────────────────────────┘
```

**Why Option C, in plain language:**

- **E1 settled narration:** Arm 1 (orchestrator-driven `session.say()`) hit 98.7 % on the sealed test set with C1 mean 213 ms / max 375 ms. Direct TTS readout means zero LLM drift on narration content — the orchestrator has full deterministic control over what is said and when.
- **Q&A is what Agora is good at, out of the box:** the native ASR → LLM → TTS loop is already tuned end-to-end in Agora-managed mode. Forcing Q&A through our own LLM proxy adds round-trips (Agora ASR → our server → LLM → our server → Agora TTS) for no gain in this scenario — the user's question doesn't need orchestrator-side reasoning to be answered.
- **The orchestrator only does what only it can do:** maintain main_line progress state, schedule barge-in handling, emit bridge lines, re-script the next 1-2 segments after a Q&A. Everything else is Agora's job.
- **LLM swap is a one-line change** via the existing BYOK custom-LLM endpoint (`app/api/chat/completions/route.ts`) — no architectural reshuffle if we want Gemini Flash later. E1 confirmed the SDK has a built-in `Gemini` vendor that drops in cleanly.

**Where Option C disagrees with v0.1:** v0.1 ("Talkthrough") committed to "narration AND Q&A both flow through the same Agora agent channel via v2.6 text-injection" — i.e., it conflated narration and Q&A as one mechanism. v0.3 splits them: orchestrator drives narration, Agora drives Q&A. This is closer to how a human teacher actually works.

**Where Option C disagrees with v0.2:** v0.2 reopened the choice between A (orchestrator-owns-all-LLM) and B (Agora-owns-all-LLM). E1 didn't directly compare those two, but it eliminated B-for-narration (system-prompt swap doesn't influence what `say()` produces) and made A-for-narration trivial. C is the natural simplification of "A for narration, B for Q&A."

---

## 5. State Machines (the moat)

### 5.1 Dual state machine

Two state machines run in parallel. The **outer** governs which line we're on (main vs branch). The **inner** governs micro-behavior within each line.

```
┌──────────────────────────────────────────┐
│           OUTER (line) FSM               │
│                                          │
│   MAIN ──────barge_in─────► BRANCH       │
│    ▲                          │          │
│    │                          │          │
│    └────end_of_branch_detected┘          │
│                                          │
└──────────────────────────────────────────┘

   In MAIN:                       In BRANCH:
┌────────────────────────┐    ┌─────────────────────────┐
│ INNER (narration) FSM  │    │ INNER (qa) FSM          │
│                        │    │                         │
│  SPEAKING              │    │  LISTENING              │
│   │                    │    │   │                     │
│   ├─ segment_done ────►│    │   ├─ user_done ───────► │
│   │  ┌──────────────┐  │    │   │  ┌──────────────┐   │
│   ├─►│ ELICITING    │  │    │   ├─►│ ANSWERING    │   │
│   │  │ (paused)     │  │    │   │  │              │   │
│   │  └──┬───────────┘  │    │   │  └──┬───────────┘   │
│   │     │  answered     │    │   │     │ answer_done  │
│   │     ▼               │    │   │     ▼               │
│   ├─ EVALUATING ───────►│    │   ├─ CHECKING_DONE    ─►│
│   │                    │    │   │                     │
│   └─ next_segment ─────┘    │   └─ end_of_qa ─►(exit) │
│                        │    │                         │
└────────────────────────┘    └─────────────────────────┘
```

### 5.2 Progress state (shared object)

The single object every component reads and writes.

```json
{
  "session_id": "sess_abc123",
  "content_id": "paper:transformer_compression",
  "outer_state": "MAIN",
  "inner_state_main": "SPEAKING",
  "inner_state_branch": null,

  "main_line": {
    "current_segment_id": "s7",
    "current_segment_position_ms": 4200,
    "covered_points": ["intro", "problem_setup", "method_step_1"],
    "remaining_points": ["method_step_2", "results", "limitations", "takeaway"],
    "elicitation_nodes_hit": ["s3", "s5"],
    "comprehension_signal": {
      "elicitations_asked": 2,
      "elicitations_correct": 2,
      "user_follow_up_depth_avg": 0.0,
      "current_depth_setting": "default"
    },
    "visual": {
      "active_clip_id": "fig2.mp4",
      "playhead_ms": 4200,
      "frozen": false
    }
  },

  "branch_line": {
    "active": false,
    "user_question": null,
    "scheduling_decision": null,
    "qa_turn_count": 0,
    "started_at": null,
    "expected_resume_segment_id": null
  },

  "history": [
    {"turn": 1, "speaker": "tutor", "segment_id": "s1", "text": "..."},
    {"turn": 2, "speaker": "user", "text": "Wait — what's pruning?"},
    {"turn": 3, "speaker": "tutor", "qa": true, "text": "Inference-time masking..."}
  ]
}
```

This object is the contract between orchestrator, visual layer, and (if Option A) the LLM proxy.

### 5.3 The three hard transitions

#### 5.3.1 `MAIN → BRANCH` (barge-in)

Trigger: Agora sends `user_started_speaking` event on the RTM channel.

Steps:

1. Stop TTS immediately. In Option A: `POST /agents/{id}/interrupt`. In Option B: rely on Agora's auto-interrupt and confirm with `interrupt`.
2. Freeze visual playhead. `visual.frozen = true`.
3. Buffer current `inner_state_main` so resume knows what to do.
4. Wait for `user_finished_speaking` + final transcript.
5. **Classify** the question (see §5.4): answer-now vs defer.
6. Set `outer_state = BRANCH`, `inner_state_branch = ANSWERING`, populate `branch_line.user_question`, `scheduling_decision`, `expected_resume_segment_id`.

#### 5.3.2 `BRANCH internal: ANSWERING → CHECKING_DONE → end_of_qa`

The "is this Q&A over yet?" problem. Agora tells us *who's speaking and when*; it does not tell us *whether the exchange is semantically resolved*. We use two signals:

- **Lightweight LLM intent check**: after each tutor answer, classify the user's last utterance (or silence) as `follow_up | satisfied | unrelated`.
- **Active confirm (the safety net)**: every 1-2 turns, the tutor proactively asks *"Make sense? Want me to keep going?"* — converts the end-detection from "guess what user means" to "user explicitly told us." This is also what a real teacher does. Defaults to ON for the demo because it's the more reliable signal.

#### 5.3.3 `BRANCH → MAIN` (graceful resume)

Trigger: `end_of_qa = true`.

Steps:

1. **Incremental re-script** the next 1-2 segments (async, ~300-800ms LLM call). Feed the LLM:
   - Last 2 user turns + tutor's last answer (so it can reference what was just resolved)
   - Original segment text for the next 1-2 segments
   - `covered_points[]`, `remaining_points[]`
   - The bridge style guide
2. **Speak a bridge line** while the re-script generates. Bridge has two parts:
   - Acknowledgment of the resolved Q&A: *"Right — so, to your question about pruning, that's settled."*
   - Re-orientation: *"Coming back to where we were: the method's third step…"*
3. When re-script returns, replace the next 1-2 segments in `main_line` and resume narration.
4. Unfreeze visual. Resume playback from `playhead_ms`.
5. Reset `branch_line.*`, set `outer_state = MAIN`.

### 5.4 Barge-in scheduling decision

When the user interrupts, we make a synchronous call (or hardcoded rule for the demo) that returns one of:

| Decision | When | Behavior |
|---|---|---|
| `answer_now` | Default. Most questions. | Enter BRANCH, answer, resume. |
| `defer_to_segment` | Question maps cleanly to a `remaining_point` that comes up in the next 1-3 segments. | Tutor says *"Good question — that's actually the next thing I cover."* and resumes WITHOUT entering BRANCH. Remember the question; when the relevant segment arrives, prepend *"Remember when you asked about X? Here it is."* |
| `dismiss_gently` | Off-topic, especially in the storybook scenario (kid asks about something unrelated). | Tutor acknowledges + gently redirects: *"Ooh, interesting — let's see what happens to Lily first, and we'll come back to that."* Resume. |

Implementation: a single LLM call with a 3-shot prompt and the question + `remaining_points[]`. Falls back to `answer_now` on any failure or ambiguity.

### 5.5 Comprehension tracker (the depth dial)

A simple scalar per session.

```python
def adjust_depth(comprehension_signal):
    correct_rate = elicitations_correct / max(elicitations_asked, 1)
    follow_up_depth = user_follow_up_depth_avg

    if correct_rate >= 0.8 and follow_up_depth < 0.3:
        return "deeper"      # user gets it; raise the ceiling
    if correct_rate <= 0.4 or follow_up_depth > 0.7:
        return "simpler"     # user struggling or hyper-curious; slow down
    return "default"
```

`current_depth_setting` feeds into the structuring layer's segment-detail prompt. Re-scripts honor it.

For the demo, this only needs to flip "deeper" or "simpler" *once* visibly during the run. Don't over-engineer the dial.

---

## 6. Visual Layer Integration (Remotion ↔ Narration)

The existing `video_story_README.md` pipeline turns a single illustration into a 10-second "breathing" Remotion clip. We extend its role.

### 6.1 Per-segment visual

Each narration segment has at most one paired visual clip:

```json
{
  "segment_id": "s7",
  "text": "The third step is where things get interesting...",
  "approx_duration_ms": 11000,
  "elicitation_node": false,
  "visual": {
    "clip_path": "out/segments/s7.mp4",
    "loop": true,
    "freeze_on_pause": true
  }
}
```

### 6.2 When clips are generated

- **Storybook**: page illustrations exist. The Remotion pipeline animates each into a loopable clip. **All clips pre-rendered** before session starts. ~10s/page × 12 pages = ~2 min one-time setup.
- **Paper**: we extract key figures from the PDF (figure 1, figure 2, table 3...) and animate the ones the script segments reference. Pre-rendered for the demo path. Future work: on-demand generation of explanatory diagrams per segment.

### 6.3 Playhead control

The orchestrator owns `visual.playhead_ms`. The web client (Next.js) has a `<VisualPlayer>` component that:

- Renders the current clip (HTML5 `<video>` element, `playsInline`, muted because narration audio comes from Agora).
- Subscribes to a small WebSocket / Server-Sent-Events channel from our backend for `play | pause | seek | swap_clip` commands.
- On barge-in: receives `pause`, freezes on current frame.
- On resume: receives `play`, continues from same frame.
- On segment advance: receives `swap_clip(new_clip_id)` with crossfade.

### 6.4 Audio-visual sync tolerance

Goal: visual transitions land within ±300ms of the narration segment boundary. Mechanism:

- Orchestrator times the `swap_clip` event with the moment it pushes the next-segment text to Agora (in Option A) or the moment Agora's `agent_speaking_started` event fires for the new segment (in Option B).
- Agora's `AGENT_METRICS` RTM events report per-stage latency — we use the LLM+TTS latency reading to predict when audio will actually start, and schedule the visual swap to match.

This is **doable but worth Phase-0 measurement** because Agora's TTS startup latency variance directly affects how tight we can pull the visual.

---

## 7. Components & Repos

| Component | New / Existing | Lives in |
|---|---|---|
| Structuring layer (PDF/text → segmented script) | New | `apps/structurer/` (Python or TS, LLM-driven) |
| Orchestrator (state machine + barge-in scheduler) | New | `apps/orchestrator/` (TS, runs inside Next.js server) |
| Agora session wrapper | Mostly existing — extends `agora-voice-demo` | `agora-voice-demo/app/api/{invite-agent,chat/completions,stop-conversation}/` |
| Visual layer player | New small component | `agora-voice-demo/components/VisualPlayer.tsx` |
| Visual generator | Existing | `talkalong/` (Remotion) — invoked from structurer |
| Demo client (UI) | Extends quickstart | `agora-voice-demo/components/` |

The Agora-Convo-AI Next.js quickstart (already cloned at `agora-voice-demo/`) is the substrate. The orchestrator is a new module that imports `agora-agent-server-sdk` and lives alongside the existing routes.

---

## 8. Open Questions

These are questions we **don't decide in this PRD** because answering them requires running the Phase-0 experiments (§9) or a separate product call:

1. **Option A vs B vs C.** Resolved by §9 Experiments E1, E2, E3.
2. **End-of-QA detection: AI-confirm-always vs intent-classifier?** Default to AI-confirm-always for the demo; experiment with classifier in §9.E5 only if time permits.
3. **Bridge-line library**: pre-written set of ~20 vs LLM-generated on the fly. Trade-off is consistency vs variety. Demo can use the pre-written set; record this as a productization decision.
4. **Paper PDF parser**: which library handles structured papers well? (PyMuPDF, GROBID, Marker, …) Out-of-scope to pick here; structurer team picks.
5. **Latency budget per stage** (target end-to-end <1.5s from user-stop to tutor-start in BRANCH): allocated only after §9.E2 measures actuals.
6. **Storybook IP risk**: use public-domain or commission original illustrations for the demo. Product/legal call.
7. **Re-script asynchrony pattern**: bridge-line spoken in parallel vs sequential with re-script — depends on Option choice and Agora's `/speak` queueing semantics (§9.E4).
8. **What happens when the user interrupts during a bridge line or during a Q&A answer?** Stack the interrupts? Drop the outer one? **Demo policy: ignore the second interrupt** until the first resolves. Future work: nestable BRANCH.

---

## 9. Phase 0 — Experiments Required Before Architecture Lock

> **Status as of 2026-05-28:**
>
> | Exp | Status | Outcome |
> |---|---|---|
> | E1 — Text-injection round-trip + barge-in fidelity | **✓ DONE** | Arm 1 wins, 98.7 % test pass-rate, C1 mean 213 ms, C2 mean 192 ms. See [conclusion](experiments/2026-05-27-e1-agora-narration-control/conclusion.md). |
> | E2 — Q&A latency on Option A vs Option B | **DEFERRED** | Requires server-side user-message injection. The `agora-agent-server-sdk`'s `AgentsClient` exposes only `start/list/get/getHistory/getTurns/stop/update/speak/interrupt` — no chat injection. Realistic implementation: Playwright with `--use-fake-device-for-media-stream` + a tiny page running `AgoraVoiceAI`. **Estimated cost: 4-8 hours of new harness work.** Not required for architecture lock since narration (E1) is locked and Q&A naturally uses Agora's native loop; only matters when picking between Agora-resold OpenAI vs BYOK Gemini at scale. |
> | E3 — Mode discipline (Option B sanity) | **DEFERRED** | Same blocker as E2. Lower priority now that Option C is locked — Option B is no longer required for narration; mode-discipline matters only if we ever want to swap Q&A mechanism via `/update` (currently we don't plan to). |
> | E4 — Resume bridge timing | DEFERRED until orchestrator scaffold exists | Integration-phase work; not architecture work. |
> | E5 — Visual playhead pause/resume | DEFERRED until `<VisualPlayer>` component exists | Integration-phase work. |
> | E6 — Web SDK feature gap confirmation | **PARTIALLY ✓** | E1 baseline + arm1 + arm2 runs confirm `/speak`, `/interrupt`, `/update`, `getTurns()`, `getHistory()`, and Agora-managed pipeline all work on Web. Open: explicit Safari + RTM `agent-error` propagation under interrupt-during-speak. Validate during integration. |
>
> The experiments below are kept verbatim from v0.2 for traceability. Sections about Option A vs B comparison are now of historical interest only — see §4.6 for the locked decision.

These experiments were planned **before** committing to Option A vs B (§4.5). Each is scoped to ≤4 hours so all of Phase 0 fits in ~2 days.

> **Method note:** each experiment ships a measurable artifact. "It seemed to work" is not a pass.

### E1 — Text-injection round-trip + barge-in fidelity (Option A feasibility)

**Goal:** Prove we can push arbitrary text to a running Agora agent, have it spoken, interrupt it cleanly, push different text, and have *that* spoken — without recreating the session.

**Steps:**

1. From the existing `agora-voice-demo` baseline, write a script that calls `POST /agents/{id}/speak` with segment A.
2. Mid-utterance, call `POST /agents/{id}/interrupt`.
3. Immediately call `POST /agents/{id}/speak` with segment B.
4. Measure: time-from-interrupt-call to silence; time-from-speak-call to first audio.

**Pass criteria:**

- Interrupt → silence: **<300ms**
- Speak → first TTS audio: **<800ms**
- Five consecutive cycles all pass.

**Why it matters:** If `/speak` doesn't return audio fast enough or `/interrupt` doesn't kill the previous utterance, Option A's resume bridge will sound broken.

**Reference:** Agora ConvoAI README — `/speak` priority enum `INTERRUPT | APPEND | IGNORE`; `interruptable: false` to prevent user cut-in.

### E2 — Q&A latency on Option A vs Option B

**Goal:** Measure end-to-end "user stops talking → tutor starts speaking" for a Q&A turn in both architectures.

**Steps:**

1. **Option A path:** Configure the agent to use the BYOK custom-LLM endpoint (`app/api/chat/completions/route.ts`) pointed at our local proxy. Our proxy logs request-in time and response-first-token time.
2. **Option B path:** Use Agora-resold OpenAI directly (the default after the demo we just stood up). System prompt is "tutor in QA mode."
3. Same 10 test questions, 5 runs each. Average.

**Pass criteria:** Whichever wins by <300ms is "tied"; whichever wins by >300ms wins outright. The losing option is dropped unless it has a structural advantage on E3/E4.

### E3 — Mode discipline test (the v0.1 PRD's blind spot)

**Goal:** Can Option B reliably switch between narration mode and Q&A mode with only `POST /agents/{id}/update` to swap the system prompt?

**Steps:**

1. Start an Option B session with system prompt: *"You are the narrator. Speak the following segment verbatim, then stop and wait."*
2. Have the user barge in and ask a question.
3. Swap system prompt to: *"Answer the user's question briefly, then end with 'shall I keep going?'"*
4. Score 20 turns on three rubrics:
   - Did the tutor stop being a narrator and become a Q&A respondent on the very next turn? (1/0)
   - Did it stay in Q&A mode for the entire branch? (1/0)
   - When swapped back to narrator mode, did it pick up the *correct* next segment without making up content? (1/0)

**Pass criteria:** ≥17/20 on each rubric. Below that, Option B loses.

**Why it matters:** Option B sounds clean on paper, but `/update` semantics + LLM stickiness might make mode-swap unreliable. We don't want to find out two days before the demo.

### E4 — Resume bridge timing (both options, same test)

**Goal:** Measure the gap between "Q&A answer ends" and "narration resumes" — the listener's worst experience is dead air.

**Steps:**

1. Trigger a barge-in → Q&A → resume cycle.
2. Measure: gap between last word of Q&A answer and first word of bridge line; gap between last word of bridge line and first word of resumed narration.
3. Both options. 10 cycles each.

**Pass criteria:** Total dead air (sum of the two gaps) **<1.2s** consistently.

### E5 — Visual playhead pause/resume latency

**Goal:** Confirm we can pause and resume the Remotion-rendered clip in the browser fast enough to feel coordinated with audio.

**Steps:**

1. Render a 30s Remotion clip via the existing pipeline.
2. Build a tiny `<VisualPlayer>` with WebSocket pause/play.
3. Trigger barge-in (using our own simulated event). Measure pause delay; measure resume delay; measure delta from audio-pause to visual-pause.

**Pass criteria:** Visual pause/play within **±150ms** of audio events.

### E6 — Web SDK maturity confirmation (kills v0.1 risk R4)

**Goal:** Confirm the Web SDK supports every feature we need: barge-in events on RTM, `/speak`, `/interrupt`, `/update`, `AGENT_METRICS`. The v0.1 PRD flagged this — the baseline we just stood up implies most are supported, but specifically check `/speak`+interrupt mid-utterance under Chrome and Safari.

**Pass criteria:** All features fire on RTM as documented on both Chrome and Safari.

### Decision matrix (filled after experiments)

| Criterion | Option A | Option B | Weight |
|---|---|---|---|
| E1 interrupt fidelity | _ | _ | 3 |
| E2 Q&A latency | _ | _ | 3 |
| E3 mode discipline | n/a (A always passes) | _ | 4 |
| E4 resume bridge timing | _ | _ | 2 |
| Engineering cost to demo | low (proxy already exists) | low (just `/update`) | 1 |

Sum the column. Higher wins. Document the call in §11.

---

## 10. Build Plan & Milestones

Strategy: **resolve the architecture in Phase 0, then build the vertical slice on the winning option.** Don't start the orchestrator until Phase 0 lands — refactoring the state machine after the fact is the most expensive mistake we can make.

### Phase 0 — Architecture experiments (2 days) — ✓ DONE 2026-05-28

E1 ran. Arm 1 (orchestrator `session.say()` + per-row session restart) won at 98.7 % pass-rate on sealed test set. Architecture locked to Option C (hybrid). E2/E3 deferred — see §9 status table. §11 ADR filled. Implementation can begin Phase 1.

**Pattern shape now known (use this verbatim in Phase 1):**

```typescript
// One agora-agent-server-sdk session per content row (typically 5-12 narration segments).
const session = agent.createSession(client, {
  channel: `tutor-${Date.now()}-${row.id}`,
  agentUid: env.agentUid,
  remoteUids: ['*'],
  idleTimeout: 120,
  expiresIn: ExpiresIn.minutes(20),
});
await session.start();

for (const segment of row.segments) {
  await session.say(segment.text, { priority: 'INTERRUPT' });
  // ... await narration playback ...
  // If user barge-in event arrives via RTM (agent_state -> SPEAKING from user UID):
  //   await session.interrupt();        // stop our narration
  //   // Agora's LLM picks up the user turn natively (Q&A handled by native loop)
  //   // ... wait for agent_state -> IDLE/LISTENING (end of Q&A) ...
  //   await session.say(bridge_line, { priority: 'INTERRUPT' });
  //   // ... continue with next segment ...
}

await session.stop();
```

### Phase 1 — Plumbing (½ day, after Phase 0)

- Stand up the orchestrator skeleton (just an empty state machine + the progress-state object as a class)
- Wire the chosen Agora path (A or B)
- Confirm `AGENT_METRICS` events reach the orchestrator over RTM

### Phase 2 — Narration only (½ day)

- Structuring layer turns one paper into segmented script with elicitation tags
- Orchestrator drives narration end-to-end (no interrupts yet)
- Progress state advances per segment

### Phase 3 — Barge-in → Q&A → manual resume (1 day)

- Wire RTM `user_started_speaking` into orchestrator
- BRANCH state implemented; tutor answers in persona
- End-of-QA = AI-confirm-only (skip classifier for now per §5.3.2 fallback)
- Resume via hardcoded bridge line

### Phase 4 — Graceful resume + incremental re-script (1 day)

- Add async re-script of next 1-2 segments, masked by bridge line
- This is the **demo's "wow" moment** — prioritize finishing.

### Phase 5 — Proactive elicitation (½ day)

- Pre-planted elicitation nodes fire
- 3-way branch on response (correct / wrong / silence)
- Comprehension tracker updates; depth dial flips once for the demo

### Phase 6 — Visual layer integration (½ day)

- `<VisualPlayer>` component with WebSocket pause/play
- Wire to orchestrator's `visual.*` state
- Test pause/resume sync on real demo content

### Phase 7 — Storybook swap (½ day, **cuttable**)

- Different structuring prompt, persona, elicitation templates
- Reuse same orchestrator, same Agora session shape
- Smoke-test on one book

### Phase 8 — Demo polish + capture (remaining)

- Script the 90-second walk-through:
  *"Open → start → AI narrates first segment → user interrupts with a real question → AI answers in persona, then bridges back → resumes correctly → reaches an elicitation node → branches on the user's answer → wraps."*
- Capture for short-video.

**Cut order if behind:** Phase 7 → Phase 6 (degrade to static image) → Phase 5 (elicitation). **Never cut Phase 4** — graceful resume *is* the product.

---

## 11. Architecture Decision Record (locked 2026-05-28)

> **Status:** LOCKED. Backing experiment: E1 (`docs/experiments/2026-05-27-e1-agora-narration-control/`).
>
> **Decision:** **Option C (hybrid).** Orchestrator owns the narration delivery via `session.say(text, INTERRUPT)`. Agora owns the Q&A turn loop via its native ASR → LLM → TTS pipeline. Per-row Agora-session restart pattern (one session per content row, ~5 segments) to avoid the implicit ~40-api_speak-turn-per-session ceiling.
>
> **Date:** 2026-05-28
>
> **Evidence (E1, sealed test set, n=75 cycles per arm):**
>
> | Metric | baseline | arm1 (LOCKED) | arm2 |
> |---|---|---|---|
> | Pass-rate (C1+C2+C3) | 0 % | **98.7 %** | 98.7 % |
> | C1 (interrupt → silence) | n/a | 213 ± 31 ms (max 375) | 242 ± 166 ms (max **1649**) |
> | C2 (speak → first audio) | n/a | 192 ± 28 ms (max 272) | 212 ± 43 ms (max 488) |
> | TTS TTFB mean | n/a | **185 ms** | 550 ms |
>
> Arms 1 and 2 tied on the binary metric. Pre-registered latency tiebreaker (lower C1 max + TTS TTFB mean) selected arm 1. Per-slice (short / mid / long): arm 1 passes all with ≥ 96 %. Conclusion + 3 charts in `docs/experiments/2026-05-27-e1-agora-narration-control/conclusion.md`.
>
> **Trade-offs accepted:**
>
> 1. **No fine control over Q&A LLM output by default.** Q&A turns are generated by Agora's LLM (currently OpenAI gpt-4o-mini via Agora resale) reading the persona system prompt. Mitigation: BYOK custom-LLM endpoint (`app/api/chat/completions/route.ts`) is already present in the cloned quickstart; flip-the-switch to swap to Gemini, Claude, or our own proxy if Q&A behavior needs orchestrator-side reasoning.
> 2. **Per-row session restart adds ~1.5 s setup overhead per row.** Acceptable for hackathon and likely for production (the user pauses between content sections anyway). If long contiguous narration becomes a requirement, revisit with longer-session experiments.
> 3. **No Gemini Q&A validation yet.** Arm 2's E1 numbers show Gemini Flash has a 3 × higher TTS TTFB (550 ms vs 185 ms) and a tail outlier C1 of 1649 ms — these may or may not transfer to Q&A turns. E2 will settle it; for now, default to OpenAI gpt-4o-mini.
> 4. **Arm 3 (Option B for narration) was never measured.** Dropped at Phase 3a because the SDK can't trigger an LLM-driven narration without a real user voice turn. If Option B *for Q&A* ever needs evaluation, E3 with mic simulation does it.
>
> **Reversibility:**
>
> - Swapping the Q&A LLM (arm 1 ↔ arm 2 ↔ custom): trivial. One environment variable + restart of the agent session. The orchestrator code does not change.
> - Backing off Option C entirely (e.g., to Option B if `/update` mode-swap becomes preferable): requires re-architecting the orchestrator's narration loop, replacing every `session.say()` call with a `session.update({llm.system_messages: ...})` + chat-message trigger. **Blast radius: medium** — ~1-2 days of focused refactor since the boundaries are well-defined. The `session.say()` path stays available as a fallback either way.
> - Moving to a pure "orchestrator owns both narration AND Q&A LLM" model (Option A): requires routing all turns through the BYOK proxy and implementing our own turn-detection on top of Agora ASR events. **Blast radius: large** — adds a stateful conversation manager our orchestrator currently doesn't need. Only worth doing if Q&A tuning becomes a competitive lever.
>
> **Confidence band:** **HIGH.** E1 sealed-test pass-rate (98.7 %) closely matches dev pooled (99.0 %) — no overfit signal. The latency distribution is tight enough that one outlier moves arm 2's max, but arm 1's max stays at 375 ms across 75 test cycles. The per-row session restart fix is well-understood (Agora platform ceiling) and orthogonal to the architecture decision.

### 11.1 Sub-decision — Q&A LLM model (E1.5, 2026-05-28)

**Decision:** Default `gemini-3.1-flash-lite` for any path that swaps the Agora-resold OpenAI for Gemini. Tested via `docs/experiments/2026-05-28-e1.5-gemini-model-pick/`.

**Evidence (n=12 per model, OpenAI-compat streaming endpoint, `reasoning_effort='minimal'`):**

| Model | TTFT median | TTFT max | Total median | Notes |
|---|---|---|---|---|
| `gemini-3-flash-preview` | 903 ms | 1148 ms | 1339 ms | `preview` tag = stability risk |
| `gemini-3.5-flash` | 970 ms | 1068 ms | 1241 ms | Made 2 factual / intent-reading errors in the 6-prompt set |
| **`gemini-3.1-flash-lite`** | **552 ms** | 3103 ms* | **858 ms** | Winner — 40-45 % faster median, no quality regression, tutor-style follow-ups land naturally |

\* 1 outlier in 12 trials (~8 %); mitigated at production via Agora's session timeout/retry.

### 11.2 MANDATORY Gemini SDK setting

If we ever pass a Gemini model to `agora-agent-server-sdk`'s `Gemini` provider, **the config object MUST include `params: { reasoning_effort: 'minimal' }`**. Without it, `gemini-3-flash-preview` and `gemini-3.5-flash` default to thinking mode, which:

- Spends max-token budget on hidden reasoning before any visible text
- Pushes TTFT to **2.3-2.5 s** (vs ~0.8-1.0 s with the setting)
- Truncates the visible response at `finish_reason='length'`

Baked into `agora-voice-demo/scripts/e1/arms/arm2_gemini.ts`. Use that file as the canonical reference shape. Bug is invisible to local lint, build, and typecheck — only the conversation feel changes — so the only safeguard is the rule in code + this paragraph.

`gemini-3.1-flash-lite` doesn't carry the bug today (no strong thinking on the lite tier) but ship the setting anyway — it's a no-op there and a survival flag for any future migration.

---

## 12. Risks & Mitigations

| ID | Risk | Mitigation |
|---|---|---|
| R1 | End-of-Q&A misjudged → tutor cuts user off or awkwardly waits | AI-confirm fallback always-on for demo; classifier post-hackathon |
| R2 | Re-script latency makes tutor "freeze" | Incremental re-write of 1-2 segments + async + bridge-line masking. Bridge line is **never** LLM-generated on the critical path — pre-written library |
| R3 | ~~Option B mode-discipline fails E3~~ — **resolved by architecture lock**: narration is locked to `session.say()` (orchestrator-driven), so Option B's mode-discipline is not on the critical path. Risk re-opens only if we later move Q&A control out of Agora's native loop into a system-prompt-swap pattern, which is explicitly not the v0.3 plan. | Lock in §4.6 + §11; tracked under "reversibility cost" in the ADR. |
| R4 | Agora Web SDK feature gaps | Confirmed mostly via baseline standup; final check in E6 |
| R5 | Storybook child safety / age-appropriateness | Persona prompt enforces it; manual content vetting; "dismiss gently" decision class in §5.4 |
| R6 | Scope creep toward "any content" generalization | Hard-freeze to paper + storybook for hackathon |
| R7 | IP/branding using named characters | Public domain or original content only for the demo |
| R8 | Visual playhead drifts from audio under network jitter | Best-effort sync only; clip is loopable so visual freeze ≈ acceptable. If drift exceeds ±500ms, fall back to static image for the demo. |
| R9 | Two interrupts stacked (user barges in *during* a Q&A answer) | Demo policy: ignore second interrupt until first resolves. Documented in §8.8 |
| R10 | Comprehension tracker over-corrects depth and breaks demo flow | Cap the dial to *one* flip per session for demo. Hand-tunable threshold |

---

## 13. Success Criteria (demo-able, not vanity)

- **Loop runs live, unscripted, on real content** without manual intervention. (binary, must-hit)
- **Resume feels seamless:** after Q&A, no repeated content, no "starting over", correct thread. (judged by 3 fresh viewers; ≥2/3 unprompted positive reaction)
- **At least one proactive elicitation** fires and branches correctly on the user's answer.
- **Perceived Q&A latency** feels conversational (target: tutor answer begins <1.0s after user stops, measured end-to-end).
- **Engine reuse proven:** storybook runs on the same orchestrator (Phase 7 lands).
- **Visual sync acceptable:** no observer notices the visual lagging audio in the demo cut.

---

## 14. Appendix

### 14.1 Glossary

- **Main line / narration:** the tutor's pre-planned lesson driven proactively.
- **Branch line / Q&A:** user-interrupt-triggered detour; must resolve and return.
- **Elicitation node:** pre-planted point where the tutor proactively asks a question.
- **Incremental re-script:** regenerating only the next 1-2 segments after an interruption.
- **Progress state:** the shared object tracking what's covered, what remains, current mode.
- **Bridge line:** the pre-written acknowledge-and-reorient utterance between branch-end and main-resume.
- **Comprehension signal:** rolling score from elicitations + follow-up depth, used to dial segment depth.

### 14.2 References

- `proactive_engine_README.md` (v0.1 PRD, this document's predecessor — supersedes its architecture commitment)
- `video_story_README.md` (Remotion illustration-to-video pipeline)
- `agora-voice-demo/` (Agora ConvoAI Next.js quickstart, working baseline as of 2026-05-27)
- `agora-voice-demo/app/api/chat/completions/route.ts` (BYOK custom-LLM proxy — the foundation of Option A)
- `agora-voice-demo/app/api/invite-agent/route.ts` (session config, `interruptable`, vendor selection)
- Agora ConvoAI architecture reference: `https://github.com/AgoraIO/skills/blob/main/skills/agora/references/conversational-ai/architecture.md`
- Agora ConvoAI v2.6 text-injection capability — capability the v0.1 PRD relied on; **must verify availability in current Agora release** as part of E1
- ConvoAI OpenAPI spec (live): `https://docs-md.agora.io/api/conversational-ai-api-v2.x.yaml`

### 14.3 What changed from v0.1

| v0.1 said | v0.2 says |
|---|---|
| "Narration and Q&A both flow through the same Agora agent channel via v2.6 text-injection" — commits to Option A | Reopens. §4 + §9 settle by experiment |
| Visual layer not addressed | §6 integrates the existing Remotion pipeline; §9.E5 validates pause/resume |
| Comprehension signal mentioned but not modeled | §5.5 specifies the dial + rules |
| Barge-in scheduling = "simple classifier" | §5.4 specifies 3-way decision + fallback |
| No Phase 0 experiments before lock-in | §9 is the gate |
| Hackathon milestones assumed Option A | §10 rebuilds milestones to run *after* the architecture decision |

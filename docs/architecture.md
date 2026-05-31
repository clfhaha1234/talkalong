# talkalong — architecture deep dive

> The landing [README](../README.md) gives the one-breath version. This is the full
> picture: the core loop, what we build vs. what Agora rents, and the three
> architectures we rejected before settling on "same agent channel".

## The core loop

```
                  ┌──────────────────────────────────────────┐
                  │      ① STRUCTURING                       │
                  │  Content → 5-segment script              │
                  │  + pre-planned elicitation nodes         │
                  │  + main-line progress state              │
                  └────────────────┬─────────────────────────┘
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │     ② ORCHESTRATION  (this repo's moat)              │
        │                                                      │
        │   state: NARRATING → INTERRUPTED → QA → RESUMING     │
        │                                                      │
        │   tracks: current_segment, covered_points[],         │
        │           remaining_points[], qa_history[]           │
        │                                                      │
        │   resume planner: emits {strategy, bridge_text,      │
        │   replacement_segments[], active_scene_id}           │
        └─────────────────┬────────────────────────────────────┘
                          │  (same single channel)
                          ▼
        ┌──────────────────────────────────────────────────────┐
        │     ③ AGORA CONVERSATIONAL AI ENGINE                 │
        │     (rented voice I/O — ~340-650ms median)           │
        │                                                      │
        │   • voice-based auto-interrupt                       │
        │   • v2.6 text-injection (push our script as agent    │
        │     output, no stop/restart)                         │
        │   • turn detection, voice-lock anti-false-interrupt  │
        └──────────────────────────────────────────────────────┘
```

**The single most consequential design choice:** narration AND Q&A flow through the
**same** Agora agent channel via v2.6 text-injection — *not* "narration on external
TTS, Q&A on a separate LLM call." This eliminates mode-switch tearing, lets Agora's
voice-lock handle interruption uniformly, and means the listener never hears the
audio character change halfway through.

## The orchestration layer — what we build (and Agora doesn't)

| Layer | Who builds it |
|---|---|
| Mouth + ears (TTS, STT, turn detection, interrupt) | **Agora** (rented) |
| Anti-false-interrupt (voice-lock filters background voices) | **Agora** (rented) |
| Low-latency voice pipeline (~340–650ms median) | **Agora** (rented) |
| Structuring arbitrary content into a teachable script | **talkalong** |
| Main-line progress state (what's covered, what's pending) | **talkalong** |
| Deciding when a Q&A exchange is *semantically* over | **talkalong** |
| Incrementally re-scripting after an interruption | **talkalong** |
| Deciding *when* the tutor should proactively pause and ask | **talkalong** |
| Regression-testing every prompt change against a golden set | **talkalong** |

Agora gives us the mouth and ears. The brain's scheduling logic is the moat.

## Why "same agent channel" was the unlock

We considered three architectures before settling. Each failure mode below is one we
either tested or watched a sibling project ship-then-revert:

| Naive architecture | What goes wrong |
|---|---|
| **Narration via external TTS + Q&A via a separate LLM call** | Voice character changes mid-conversation. Listener notices. Worse: interrupt detection has to be wired into two pipelines and synchronized — guaranteed race on barge-in. |
| **One LLM, just prompt it to "continue from where you left off"** | LLM has no durable main-line state. After 2 interrupts it re-explains things it already said, or drops covered points entirely. Hallucinates progress. |
| **Pre-render the whole narration to MP3, play with TTS gaps** | Can't text-inject during a live session. Every interrupt requires stop/restart, which Agora docs explicitly warn against (200-500ms tearing). |
| **Same channel, text-injection (this repo)** | Narration and Q&A are both "agent output." Interrupt is uniform. Resume = inject a fresh segment after the bridge. No tearing, no voice swap, one state machine. |

The design decision isn't sexy. The consequence is — it's why the demo actually feels
like a tutor instead of a screen-reader interrupted by a chatbot.

## Where the code lives

- `agora-voice-demo/lib/orchestrator/` — the state machine, resume planner, progress state
  (`index.ts`, `resume-planner.ts`, `narrator.ts`, `progress-state.ts`)
- `agora-voice-demo/lib/lesson/` — the content layer (input → 5-scene script + illustrations);
  the only storybook-specific part. Swap it to change domains.
- Engine PRD (v0.3, architecture locked): [`agora-voice-demo/docs/proactive-tutor-engine-prd.md`](../agora-voice-demo/docs/proactive-tutor-engine-prd.md)

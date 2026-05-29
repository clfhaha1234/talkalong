# PRD — Proactive AI Narrator Engine

**Working name:** Talkthrough (placeholder)
**One-liner:** Turn any content into a living tutor that _proactively narrates_, can be _interrupted for real-time Q&A_, and _gracefully resumes_ — instead of passively waiting to be asked.
**Doc type:** Hackathon build PRD (lean, build-order-first)
**Author:** Lifei
**Status:** Draft v0.1

---

## 0. TL;DR

Most "AI explainer" experiences are _reactive_: they wait for the user to ask. A good human teacher is _proactive_: they have a lesson plan, drive through it, pause at the right moments to check understanding, and handle interruptions without losing their place.

We are building the engine that does this for **any content**. For the hackathon, we prove it on **two content types** sharing one engine:

- **Scenario A — Paper / long-form explainer** (primary build target: clearest main-line structure, strongest pain point).
- **Scenario B — Children's storybook** (secondary: high emotional/demo appeal, reuses the same engine, synergizes with the parent-child illustration project).

The hard, defensible part is **not** speech I/O (we rent that from Agora's Conversational AI Engine). It is the **orchestration layer**: structured script generation, main-line progress state, interruption→Q&A→resume scheduling, and incremental re-scripting.

---

## 1. Goals & Non-Goals

### 1.1 Goals (hackathon scope)

- Demonstrate the **full loop end-to-end** on one piece of real content: proactive narration → user interrupts → real-time Q&A → graceful resume → narration continues with updated context.
- Demonstrate **AI-initiated interaction nodes** (the tutor pauses and tosses a question to the user), not just user-initiated interrupts.
- Run the **same engine** across a paper and a storybook by swapping only the content/persona layer.
- Keep voice latency low enough to feel like a real conversation.

### 1.2 Non-Goals (explicitly out of scope for hackathon)

- Multi-user / classroom mode.
- Account systems, payments, long-term user memory across sessions.
- "Any content type" (web pages, video, arbitrary docs). Engine is _designed_ to generalize, but we only wire up paper + storybook.
- Fine-tuned models or custom voices. Use off-the-shelf LLM + TTS via Agora.
- Mobile-native apps if Web SDK is viable (see Risk R4).

---

## 2. The Core Loop (the whole product in one diagram)

```
CONTENT (paper PDF / storybook text+images)
   │
   ▼
[1] STRUCTURING LAYER  ──►  Structured Script
        - segments the content into narration chunks
        - tags each chunk: key points, cognitive nodes,
          natural pause points, pre-planned elicitation questions
        - emits an initial MAIN-LINE PROGRESS STATE
   │
   ▼
[2] ORCHESTRATION LAYER  (← our moat)
   maintains: current_segment, covered_points[], remaining_points[],
              mode = NARRATING | QA | RESUMING
   │
   ▼
[3] AGORA CONVERSATIONAL AI ENGINE  (rented: voice I/O)
   one unified agent channel handles BOTH narration and Q&A
        ├─ NARRATING : current script segment is spoken via the agent
        ├─ INTERRUPTED : Agora auto-stops playback on user voice
        ├─ QA : our LLM answers live, in persona, with content context
        ├─ END-OF-QA detection : "satisfied / has follow-up?" + AI confirm fallback
        └─ RESUME : incrementally re-script next 1–2 segments,
                    insert bridge line, continue narrating
```

**Design decision that simplifies everything:** narration and Q&A both flow through the **same Agora agent channel** (using v2.6 text-injection to push the current script segment as agent output), rather than "narration = external TTS, Q&A = separate LLM." This unifies interruption, injection, and resume so we never have to fight mode-switch tearing.

---

## 3. Why Agora (and what it does / does not cover)

Agora's Conversational AI Engine is the **voice I/O layer**. Confirmed-relevant capabilities:

- **Interruption:** voice-based auto-interrupt (engine stops the agent the moment the user speaks) and manual interrupt via REST/SDK.
- **Latency:** pipeline optimized to ~650ms (private-beta figures cite ~340ms median); good enough for natural turn-taking.
- **Anti-false-interrupt:** voice lock filters ~95% background voices, ~50% lower false-interrupt rate — important for the noisy storybook setting (kids, parents talking over each other).
- **Bring-your-own LLM:** supports custom LLMs, personalized prompts, adaptive responses, memory.
- **Text injection (v2.6, Apr 2026):** client can push custom text instructions directly into the agent's live conversation flow — this is what lets us stream script segments and dynamically update content without stop/restart.
- **Turn detection (v2.6):** refactored for OpenAI Realtime / Gemini Live, more predictable turn-taking.

**Agora does NOT cover (we build these):**

- Structuring arbitrary content into a teachable script.
- Maintaining main-line progress state.
- Deciding when a Q&A exchange is _semantically_ over.
- Incrementally re-scripting after an interruption.
- Deciding _when_ the tutor should proactively pause and ask.

> Net: Agora gives us the mouth and ears. The brain's scheduling logic is ours — which is exactly where the defensibility lives.

---

## 4. The Orchestration Layer (the moat) — detailed spec

### 4.1 State machine

States: `NARRATING`, `INTERRUPTED`, `QA`, `RESUMING`.

| From        | Event                                 | To                 | Action                                                       |
| ----------- | ------------------------------------- | ------------------ | ------------------------------------------------------------ |
| NARRATING   | reaches an elicitation node           | NARRATING (paused) | AI tosses a question; wait N seconds for response            |
| NARRATING   | user voice detected (Agora interrupt) | INTERRUPTED        | stop playback immediately                                    |
| NARRATING   | segment finished, more remain         | NARRATING          | advance `current_segment`, move points to `covered_points[]` |
| NARRATING   | no segments remain                    | DONE               | wrap-up line                                                 |
| INTERRUPTED | question captured (STT)               | QA                 | classify: answer-now vs defer-to-later                       |
| QA          | answer delivered, end-of-QA = true    | RESUMING           | trigger incremental re-script                                |
| QA          | user has follow-up                    | QA                 | continue answering                                           |
| RESUMING    | next 1–2 segments ready               | NARRATING          | speak bridge line, continue                                  |

### 4.2 Main-line progress state (the object everything reads/writes)

```json
{
  "current_segment_id": "s7",
  "covered_points": ["intro", "problem_setup", "method_step_1"],
  "remaining_points": ["method_step_2", "results", "limitations", "takeaway"],
  "mode": "NARRATING",
  "last_user_question": null,
  "elicitation_nodes_hit": ["s3", "s5"]
}
```

Re-scripting and resume both consume this so we never repeat covered content or lose the thread.

### 4.3 Three hard problems and our hackathon-grade answers

**P1 — End-of-Q&A detection (the体验 命门 / the make-or-break).**
Agora tells us _that_ the user spoke/stopped (VAD, turn detection); it does **not** tell us whether the exchange is _semantically_ complete.

- _Hackathon answer:_ lightweight LLM intent check ("does the user have a follow-up?") **+** AI-initiated confirm as the safety net: the tutor asks _"Does that make sense — want me to keep going?"_ This punts the end-decision to the user, which is both easier to implement and feels more like a real teacher.

**P2 — Re-scripting latency.** Regenerating the whole remainder makes the tutor "freeze."

- _Hackathon answer:_ **incremental re-write of only the next 1–2 segments**, generated async, masked by a spoken **bridge line** ("Right — so, coming back to where we were…").

**P3 — Answer-now vs defer.** Some interruptions deserve an immediate answer; some are best handled later ("good question — I'll get to that in a moment").

- _Hackathon answer:_ simple classifier on the captured question vs `remaining_points[]`. If the question maps to an upcoming point → defer with a promise; else → answer now. Keep the rule simple for the demo; sophistication later.

### 4.4 Proactive elicitation (the differentiator)

The structuring layer pre-plants elicitation nodes in the script. At a node the tutor stops and tosses the ball:

- Paper: _"Why do you think they used this baseline instead of X?"_
- Storybook: _"Ooh — what do you think happens next?"_
  Then it branches on the response (correct / wrong / silence) to go deeper, correct gently, or continue. This is what makes it feel _led_ rather than _played back_.

---

## 5. Scenario Layers (same engine, different content + persona)

|                   | **A. Paper / long-form (primary)**                     | **B. Storybook (secondary)**                                                                  |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| User              | students, self-learners, anyone who finds papers heavy | child + parent (co-listening)                                                                 |
| Persona           | sharp, encouraging research mentor                     | warm, playful storyteller                                                                     |
| Main-line source  | section/argument structure of the paper                | story plot arc                                                                                |
| Q&A nature        | clarify, deepen, challenge an assumption               | spark imagination, simple recall, emotion                                                     |
| Elicitation style | "Do you buy this assumption?"                          | "What would _you_ do here?"                                                                   |
| Content risk      | low                                                    | **child safety — must vet content, keep age-appropriate, no isolation/inappropriate content** |
| Demo appeal       | professional credibility                               | warmth, virality (good short-video material)                                                  |

Both consume the **identical** orchestration layer and progress-state object. Only the **structuring prompt**, **persona prompt**, and **elicitation templates** differ.

---

## 6. User Stories (hackathon-critical only)

1. As a user, I drop in a paper (or pick a storybook) and the tutor **starts talking on its own** with a clear plan — I don't have to think up questions.
2. As a user, I can **cut in mid-sentence** with a question and get an immediate, in-context, in-persona answer.
3. As a user, after my question is answered, the tutor **picks up smoothly where it left off**, not from the top, not repeating itself.
4. As a user, the tutor **occasionally pauses and asks me something**, and reacts to whether I got it right.
5. As a parent, the storybook tutor keeps it **age-appropriate** and gently brings the focus back to the story.

---

## 7. Build Plan & Milestones (hackathon)

> Strategy: vertical slice first. Get the full loop working on **one paper** before adding the storybook or polishing.

**M0 — Plumbing (½ day)**
Stand up Agora agent channel, BYO-LLM connected, confirm: agent speaks injected text; user voice auto-interrupts; manual interrupt API works. _Confirm Web SDK maturity early — see R4._

**M1 — Narration only (no interrupt) (½ day)**
Structuring layer turns one paper into a segmented, tagged script. Engine narrates it through the Agora channel end-to-end via text injection. Progress state advances per segment.

**M2 — Interrupt → Q&A → manual resume (1 day)**
Wire interrupt → STT → live LLM answer in persona. Resume via a hardcoded bridge line. End-of-QA = AI-confirm only (skip the classifier for now).

**M3 — Graceful resume + incremental re-script (1 day)**
Add main-line progress state read/write, incremental re-write of next 1–2 segments, async masking with bridge line. This is the "wow" moment — prioritize it.

**M4 — Proactive elicitation (½ day)**
Pre-plant elicitation nodes; tutor pauses and asks; branch on response.

**M5 — Storybook swap (½ day)**
Swap structuring + persona + elicitation templates. Prove engine reuse. (If time-boxed, this is the first thing to cut.)

**M6 — Demo polish + short-video capture (remaining time)**
Script the 90-second demo: start → interrupt → answer → seamless resume → proactive question. Capture clip.

**Cut order if behind:** M5 → M4 → P3 classifier (collapse into "always AI-confirm"). Never cut M3 — it _is_ the product.

---

## 8. Success Criteria (demo-able, not vanity metrics)

- **The loop runs live, unscripted, on real content** without manual intervention. (binary, must-hit)
- **Resume feels seamless:** after Q&A, no repeated content, no "starting over," correct thread. (judged by 3 test viewers)
- **At least one proactive elicitation** fires and branches on the user's answer.
- **Perceived latency** in Q&A feels conversational (target: answer begins < ~1s after user stops).
- **Engine reuse proven:** storybook runs on the same orchestration code (if M5 lands).

---

## 9. Risks & Mitigations

| ID  | Risk                                                          | Mitigation                                                                                                                  |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1  | End-of-Q&A misjudged → tutor cuts user off or awkwardly waits | Ship AI-confirm fallback ("want me to keep going?"); skip semantic classifier for demo                                      |
| R2  | Re-script latency makes tutor "freeze"                        | Incremental re-write of 1–2 segments + async + bridge-line masking                                                          |
| R3  | Narration-via-TTS not covered by Agora's interrupt detection  | Route narration through the **agent channel** (text injection), not separate TTS, so interrupt/injection/resume are unified |
| R4  | Web SDK maturity (early docs: Native first, Web later)        | Confirm current Web SDK status with Agora in M0; fall back to native if blocked                                             |
| R5  | Storybook child-safety / inappropriate content                | Vet content set manually for demo; persona prompt enforces age-appropriate, no isolation, redirect to story                 |
| R6  | Scope creep toward "any content"                              | Hard-freeze to paper (+storybook) for hackathon; "any content" is post-hackathon                                            |
| R7  | IP/branding if using named characters/works in storybook      | Use public-domain or original story content for the demo                                                                    |

---

## 10. Open Questions

1. Which **specific paper** for the primary demo? (Pick one with clean section structure and a debatable assumption to showcase the "challenge" elicitation.)
2. Web vs Native SDK final call (depends on R4 finding in M0).
3. Which **LLM** behind Agora — latency vs reasoning trade-off for live Q&A.
4. Bridge-line library: pre-written set vs LLM-generated on the fly.
5. How "covered_points" granularity is defined per content type (paper = arguments; storybook = plot beats).

---

## Appendix — Glossary

- **Main-line / narration:** the tutor's pre-planned lesson driven proactively.
- **Q&A support-line:** a user-interrupt-triggered detour that must resolve and return to the main line.
- **Elicitation node:** a pre-planted point where the tutor proactively asks the user a question.
- **Incremental re-script:** regenerating only the next 1–2 segments after an interruption, not the whole remainder.
- **Progress state:** the shared object tracking what's been covered, what remains, and current mode.

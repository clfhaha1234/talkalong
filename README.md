<div align="center">

# 🎙️ talkalong

<p><strong>A proactive AI tutor engine — it drives its own lesson, lets the listener interrupt for Q&A, then resumes the main line where it paused.</strong></p>

<p><em>Most "AI explainer" experiences are reactive: they wait to be asked. A good human teacher is proactive — they have a plan, they drive through it, they pause at the right moments, and when interrupted they answer and rejoin the thread without losing their place. talkalong is the orchestration engine that does this.</em></p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-82%20unit%20%2B%2011%20bench-success?style=flat-square)](./agora-voice-demo/scripts/qa-bench/README.md)
[![Built on](https://img.shields.io/badge/voice%20I%2FO-Agora%20Conversational%20AI-D77757?style=flat-square)](https://www.agora.io/en/products/conversational-ai-engine/)

</div>

## 🧠 What this repo is really about

The interesting question isn't *"can an LLM read a script out loud?"* — TTS has done that for a decade.

It's *"can an AI sustain a multi-turn proactive monologue, **survive an off-topic interruption**, answer it in character, and then rejoin its own main thread without losing where it was?"*

That's the loop a human teacher runs all day. It's also exactly the loop most AI products skip — they wait politely for you to ask, then forget the thread the moment the conversation goes off-piste. **talkalong is the orchestrator that makes the loop work end-to-end.**

We prove it on one demo content type — a children's storybook tutor — because it's the highest-stakes correctness setting (you can't fool a 6-year-old by faking continuity). The same engine generalizes to any long-form content: a paper walkthrough, an onboarding doc, a museum audio guide, a Khan-style lesson.

## 🎬 What this looks like in practice

A real interaction the system handles end-to-end today:

> 🤖 *"Lily wandered into a forest where the trees had silver bark, and..."*
>
> 🧒 *(interrupts)* **"Wait, why is the bark silver?"**
>
> 🤖 *(stops mid-sentence)* *"Because of the moonlight catching the leaves — silver bark is what very old trees grow in forests where the moon is always full. Now — where were we... Lily had just stepped into the silver forest, and a small fox came out from behind a tree..."*
>
> 🧒 *(interrupts again)* **"用中文讲故事。"**
>
> 🤖 *(switches language but keeps the same Lily, same silver forest, same fox)* *"莉莉刚刚走进银色的森林，一只小狐狸从树后探出头来……"*

Three things the orchestrator did that a vanilla chatbot would have flubbed:

1. **Stopped narrating the instant the kid spoke** — no talking-over.
2. **Answered in narrator voice** (no *"Sure! Great question!"*) and bridged back to the storyline mid-sentence, not from the top.
3. **Mid-story language switch preserved canon** — same characters, same scene, just a different language. Plot doesn't reset.

That third one is a regression we actually shipped and caught — see [the 11-case QA-resume bench](#-the-regression-bench-where-the-discipline-lives).

## 🔁 The core loop

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

**The single most consequential design choice:** narration AND Q&A flow through the **same** Agora agent channel via v2.6 text-injection — *not* "narration on external TTS, Q&A on a separate LLM call." This eliminates mode-switch tearing, lets Agora's voice-lock handle interruption uniformly, and means the kid never hears the audio character change halfway through.

## 🏗️ The orchestration layer — what we build (and Agora doesn't)

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
| Regression-testing every prompt change against 11 cases | **talkalong** |

Agora gives us the mouth and ears. The brain's scheduling logic is the moat.

## ⚖️ Why "same agent channel" was the unlock

We considered three architectures before settling. Each failure mode below is one we either tested or watched a sibling project ship-then-revert:

| Naive architecture | What goes wrong |
|---|---|
| **Narration via external TTS + Q&A via a separate LLM call** | Voice character changes mid-conversation. Kid notices. Worse: interrupt detection has to be wired into two pipelines and synchronized — guaranteed race on barge-in. |
| **One LLM, just prompt it to "continue from where you left off"** | LLM has no durable main-line state. After 2 interrupts it re-explains things it already said, or drops covered points entirely. Hallucinates progress. |
| **Pre-render the whole narration to MP3, play with TTS gaps** | Can't text-inject during a live session. Every interrupt requires stop/restart, which Agora docs explicitly warn against (200-500ms tearing). |
| **Same channel, text-injection (this repo)** | Narration and Q&A are both "agent output." Interrupt is uniform. Resume = inject a fresh segment after the bridge. No tearing, no voice swap, one state machine. |

The design decision isn't sexy. The consequence is — it's why the demo actually feels like a tutor instead of a screen-reader interrupted by a chatbot.

## 🧪 The regression bench — where the discipline lives

The hard part of shipping a proactive tutor isn't the happy path. It's that **every prompt tweak silently breaks ~3 weird interrupt scenarios.** The kid asks a meta-question ("are you a robot?"). The kid switches language. The kid asks about something three scenes ahead. The kid says "tell me a different story." Each of these has a "right" recovery and a "wrong" recovery, and which one your prompt produces is *not visible* until you look at all 11 cases together.

So we built [an 11-case golden set](./agora-voice-demo/docs/experiments/2026-05-28-qa-resume-benchmark/) and made it a regression gate:

```bash
cd agora-voice-demo
pnpm tsx scripts/qa-bench/extract-baseline.ts            # pull LIVE prompts from prod code
pnpm tsx scripts/qa-bench/run.ts \
  --prompts docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json \
  --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-$(date +%Y%m%d).json
```

~25 seconds on Gemini. Reads `.env.local` from the parent dir automatically.

There's also a stricter E2E variant that hits the **prod** planner (not a parameterized bench copy) and applies mechanical rubrics — substring presence/absence + expected resume strategy + a Han-character detector on `bridge_text`. That's the regression that fixed itself this morning:

```bash
pnpm tsx scripts/qa-bench/e2e-interrupt.ts                # default smoke set: C1, C2a, C2b, C3
pnpm tsx scripts/qa-bench/e2e-interrupt.ts --only C1      # debug one case
pnpm tsx scripts/qa-bench/e2e-interrupt.ts --all          # full sweep
```

And it now **grades itself**. `scripts/qa-bench/grade.ts` scores any run against each case's locked rubric — deterministic gates (language/CJK guardrail, forbidden substrings, expected strategy, structural assertions) plus a `gemini-3.5-flash` LLM judge for the semantic lines — and emits a PASS/FAIL table. No more eyeballing outputs:

```bash
pnpm tsx scripts/qa-bench/grade.ts \
  --in  docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD.json \
  --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-YYYYMMDD-graded.json
```

The bench is the reason we trust "we changed the persona prompt" before a demo, instead of crossing our fingers and reading the conversation logs after. Two sealed-held-out experiments drove the current prompts:
- [2026-05-29 interrupt-smoothness](./agora-voice-demo/docs/experiments/2026-05-29-interrupt-smoothness/) — **persona** side, dev **7.7/11 → 9.7/11**: refuse-to-compute (stop solving a kid's math mid-story) + engage-if-already-revealed (stop deflecting on a reason the story already told). Generalized to held-out.
- [2026-05-29 planner-residuals](./agora-voice-demo/docs/experiments/2026-05-29-planner-residuals/) — **planner** side, dev **9.7/11 → 10/11** + T1–T6 4/6 → 5/6: don't fold the kid's off-topic question into the narration, and restart (not continue) when the kid says "I'm lost." The no-echo fix generalized to a fresh held-out math case.

- [2026-05-29 climax-leak](./agora-voice-demo/docs/experiments/2026-05-29-climax-leak/) — **workflow** fix for the last residual: near the climax the planner was being *handed the ending scene's full text* and intermittently leaked it (C7). Redacting the final scene in the planner's lookahead to its first sentence closed **C7 0/3 → 3/3** (hit 11/11 twice) and generalized to a held-out climax question. A stronger planner model (gemini-3.5-flash) was tested as the rival arm and **falsified** — it didn't fix C7 and destabilized the set, proving the leak was structural, not model-tier.

Resume-to-main-line latency stays **~1.4 s** throughout. The prod e2e interrupt sweep now passes **9/10 (+1 semantic-skip), C7 included**; the lone remaining mechanical miss (C4) is a benchmark-rubric substring artifact, not a model failure.

## 🗂️ What's in the repo

```
talkalong/
├── README.md
├── docs/
│   └── remotion.md               # Remotion side deep dive (the only top-level doc)
│
├── src/                          # 🎞️ Half 1 — Remotion: image → ~10s breathing storybook video
│   ├── BookPage.tsx              # main composition (line draw + color fade-in + breathing)
│   ├── preprocess.ts             # one image → lineart SVG + color layer
│   └── Root.tsx
├── public/                       # Remotion-side input images
│
└── agora-voice-demo/             # 🎙️ Half 2 — Next.js + Agora voice tutor (separate pnpm project)
    ├── lib/orchestrator/         # 🧠 the moat — state machine, resume planner, progress state
    │   ├── index.ts              # session lifecycle (NARRATING → INTERRUPTED → QA → RESUMING)
    │   ├── resume-planner.ts     # LLM-emits {strategy, bridge, replacement_segments[]}
    │   ├── narrator.ts           # drives segments through Agora's text-injection channel
    │   └── progress-state.ts     # covered_points[], remaining_points[], qa_history
    ├── lib/lesson/               # content layer: user input → 5-scene script + Gemini illustrations
    ├── app/api/tutor/            # SSE narration + qa-ended routes
    ├── components/tutor/         # storybook UI (image carousel + transcript)
    ├── scripts/qa-bench/         # 🧪 11-case regression bench + E2E interrupt harness
    └── docs/                     # engine PRD, plans, experiments, screenshots — all engine-side
        ├── proactive-tutor-engine-prd.md   # v0.3 — architecture locked
        ├── plans/
        ├── experiments/                     # all 4 experiments here
        ├── screenshots/
        ├── legacy/
        └── ai/                              # AI-agent recipe docs (L0/L1/L2)
```

The two halves are **independent** npm/pnpm projects (different package managers on purpose — Remotion plays better with npm, the Next.js side with pnpm). They don't depend on each other; you can run the storybook video pipeline without touching the voice tutor and vice versa. Each half owns its own `docs/`.

## 🚀 Quick start

### A — The voice tutor (the interactive AI engine)

```bash
cd agora-voice-demo
pnpm install
cp env.local.example .env.local           # fill in: Agora App ID + Cert + GOOGLE_API_KEY
pnpm run dev                               # → http://localhost:3000/tutor
```

What you'll see: a storybook input screen, then a live tutor that reads a 5-scene story aloud, pauses for elicitation, and accepts mid-story interrupts. Talk to it; it should answer in narrator voice and rejoin the storyline.

Deeper docs:
- Subproject README: [agora-voice-demo/README.md](agora-voice-demo/README.md)
- Engine PRD (v0.3, architecture locked): [agora-voice-demo/docs/proactive-tutor-engine-prd.md](agora-voice-demo/docs/proactive-tutor-engine-prd.md)
- Agent contracts: [agora-voice-demo/AGENTS.md](agora-voice-demo/AGENTS.md)

### B — The breathing storybook video (Remotion side)

```bash
npm install                                # first run downloads Chromium (~1–2 min)
npm run generate                           # = preprocess demo_img.jpeg + render
open out/video.mp4
```

Bring your own picture:

```bash
cp /path/to/picture.jpg .
npm run preprocess -- picture.jpg
npm run render
```

Interactive preview (tweak seed/timeline in the browser):

```bash
npm run preview                            # opens Remotion Studio
```

Deeper: [docs/remotion.md](docs/remotion.md).

## ✅ Verification

```bash
cd agora-voice-demo
pnpm run typecheck                         # tsc --noEmit
pnpm test                                  # vitest — 80 unit tests, ~3s
pnpm run verify                            # full: typecheck + API contract + build
pnpm tsx scripts/qa-bench/e2e-interrupt.ts # 4-case smoke against PROD planner
```

If you're about to change the persona prompt in [`lib/orchestrator/index.ts`](agora-voice-demo/lib/orchestrator/index.ts) or the `SYSTEM` constant in [`lib/orchestrator/resume-planner.ts`](agora-voice-demo/lib/orchestrator/resume-planner.ts), **run the bench first**. That's the discipline.

## 📚 Experiments + data + conclusions

Every non-obvious decision has a frame, data, and a conclusion doc:

All four live under [`agora-voice-demo/docs/experiments/`](agora-voice-demo/docs/experiments/):

- [`2026-05-27-e1-agora-narration-control`](agora-voice-demo/docs/experiments/2026-05-27-e1-agora-narration-control) — Agora-driven proactive narration as the control arm
- [`2026-05-28-e1.5-gemini-model-pick`](agora-voice-demo/docs/experiments/2026-05-28-e1.5-gemini-model-pick) — Gemini model selection for the lesson generator
- [`2026-05-28-greeting-debug`](agora-voice-demo/docs/experiments/2026-05-28-greeting-debug) — why "Got it — let me read this through" leaked into the storybook narration (3 independent bugs, all root-caused not A/B'd)
- [`2026-05-28-qa-resume-benchmark`](agora-voice-demo/docs/experiments/2026-05-28-qa-resume-benchmark) — **the 11-case QA-resume regression bench**, with iter1/iter2/iter3 data and the locked rubric per case

## ❓ FAQ

**Why is the demo a children's storybook and not, say, a paper walkthrough?**
The PRD's primary target was a paper walkthrough (clearest main-line structure, sharpest pain point — researchers reading dense PDFs need this more than kids need bedtime stories). The storybook ended up shipping first because it's the **highest-stakes correctness setting**: you cannot fake continuity in front of a 6-year-old. If the engine handles "wait why is the bark silver, also switch to Chinese, and where's the fox now?" it handles anything. Same engine, different content layer.

**Doesn't Agora already do this?**
Agora does voice I/O — TTS, STT, interrupt, turn detection, the latency budget. Agora explicitly does **not** do: structuring content into a teachable script, maintaining main-line progress state, deciding when a Q&A is semantically over, or incrementally re-scripting after an interrupt. That's the brain. We rent the mouth and ears.

**Why same agent channel for narration AND Q&A?**
See ["Why same agent channel was the unlock"](#%EF%B8%8F-why-same-agent-channel-was-the-unlock). Short version: two channels means two interrupt pipelines and a voice-character swap mid-conversation. Same channel + v2.6 text-injection means narration is just "agent output we pushed" and Q&A is "agent output it generated" — Agora can't tell them apart, so neither can the listener.

**Why 11 bench cases and not 50?**
Each case is a distinct interrupt class with a locked rubric. Adding case 12 means writing case 12's "right recovery" by hand — you can't fuzz this; the judge is structural, not stylistic. We grew the set when we *shipped a bug the existing cases didn't catch* (case C1 — language-mirroring — was added the day we caught the regression in prod). The bench is hand-grown the same way a unit test suite is.

**Why doesn't talkalong auto-pick the persona prompt?**
A prompt the system tunes against its own bench is a prompt that drifts toward the bench. We use the bench as a **regression gate**, not an optimizer — humans propose the prompt change, the bench tells us if anything broke. See the discipline in [`scripts/qa-bench/README.md`](agora-voice-demo/scripts/qa-bench/README.md).

**Can I use a different voice provider?**
Yes — the orchestrator only depends on (a) text-injection into a live channel and (b) voice-based auto-interrupt. Any provider that exposes both will work; we currently use Agora because their v2.6 SDK is the only one that ships both today.

**Can I use this for non-storybook content?**
Yes — that's the whole point. The orchestration layer is content-agnostic; only [`agora-voice-demo/lib/lesson/`](agora-voice-demo/lib/lesson) is storybook-specific (5-scene structure, illustration generation, age-8-12 voice). Replace it with a paper-segmenter, doc-segmenter, or museum-tour-segmenter and the engine carries.

## 📄 License

[MIT](./LICENSE)

The `agora-voice-demo/` subproject was originally forked from [AgoraIO-Conversational-AI/agent-quickstart-nextjs](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs) (MIT) and has been heavily customized into the proactive-tutor orchestrator described above.

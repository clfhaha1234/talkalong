# The AI Teacher — a proactive, interruptible voice storybook tutor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**A proactive AI storyteller that turns any topic into an illustrated lesson, reads it
aloud, and pauses to answer your questions — then smoothly returns to the tale.**

Type a topic (or paste a paper); the app generates a 5-scene illustrated story,
narrates it scene by scene, and lets you **barge in by voice at any time** to ask
a question. A fast voice agent answers in character, then a slower "decision brain"
plans how to resume — continue, re-tell, or skip — and the narrator picks back up.
The story's *pacing and style* adapt to you; its *plot* does not get derailed.

The main app is the storybook tutor at [`/tutor`](app/tutor/page.tsx). This repo is
built on the Agora Conversational AI Next.js quickstart, and the original
conversation demo still ships alongside it (see [Legacy conversation demo](#legacy-conversation-demo)).

![The AI Teacher — illustrated storybook tutor reading a scene aloud, with the narration on the right and a tap-to-talk mic to interrupt](docs/screenshots/tutor-storybook.png)

## How it works (the storybook tutor)

The architecture is **two LLM roles + a deterministic spine** (a "proposer / disposer"
pattern), NOT an agentic tool loop — a choice [validated with data](docs/experiments/2026-05-29-agentic-vs-singleshot/conclusion.md)
(agentic was equal quality at ~3.6× latency, ~5× tokens).

1. **Generate** — a Gemini pass composes the lesson: scenes, narration script,
   one illustration + short "draw-on" video per scene ([`lib/lesson/`](lib/lesson)).
   The story is told in the **same language the listener typed the topic in**
   (auto-detected in [`lib/lesson/script-generator.ts`](lib/lesson/script-generator.ts);
   the detected language also drives the agent's persona via
   [`lib/language-config.ts`](lib/language-config.ts)).
2. **Narrate** — the deterministic spine ([`lib/orchestrator/progress-state.ts`](lib/orchestrator/progress-state.ts))
   is the single source of truth for "where are we in the story". A fast
   Agora-hosted voice agent speaks each scene; the UI reveals text + plays the
   scene's clip in lockstep ([`components/tutor/StoryScreen.tsx`](components/tutor/StoryScreen.tsx)).
3. **Barge in** — Agora's server-side VAD detects you speaking and pauses the
   narration (no button needed once the mic is on). The voice agent answers your
   question in the storyteller's voice.
4. **Resume** — when you go quiet, a single-shot Gemini "resume planner"
   ([`lib/orchestrator/resume-planner.ts`](lib/orchestrator/resume-planner.ts))
   composes a one-line bridge and decides the strategy (continue / restart /
   skip); the narrator resumes on the right scene.

Per-session conversation + latency is logged for debugging via
[`lib/orchestrator/session-logger.ts`](lib/orchestrator/session-logger.ts)
(console always; `logs/sessions/<ts>-<id>.txt` locally).

## Prerequisites

- [Node.js 22+](https://nodejs.org/en/download/)
- [pnpm](https://pnpm.io/installation)
- [Agora CLI](https://github.com/AgoraIO-Community/cli)

## Run It

Getting started is quick and easy: install the CLI _(skip if you already have it)_ , scaffold the Next.js quickstart using the Agora CLI, install dependencies, and run.

1. **Install the Agora CLI and sign in**
   _(skip if `agora` is already on your PATH)_:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/AgoraIO/cli/main/install.sh | sh -s -- --add-to-path
   agora login
   ```

2. **Scaffold and run**
   `agora init` clones the starter, binds an Agora project, and writes `.env.local`. (replace `my-nextjs-demo` with your own project name):

   ```bash
   agora init my-nextjs-demo --template nextjs
   cd my-nextjs-demo
   pnpm install
   pnpm dev
   ```

3. **Open the storybook tutor** at [http://localhost:3000/tutor](http://localhost:3000/tutor)
   — pick a topic, click **Begin**, and the lesson generates + narrates. Tap the
   mic once to enable voice, then just speak to interrupt. (The original
   conversation demo is at [http://localhost:3000](http://localhost:3000) →
   **Start conversation**.)

> **Note** — the tutor needs `GOOGLE_API_KEY` (Gemini) in addition to the Agora
> credentials; see [Environment variables](#environment-variables). The Agora CLI
> writes only the Agora keys, so add the Gemini key to `.env.local` yourself.

> **About Agora auth** — running the app does **not** trigger any web sign-in.
> The app only reads your project's **App ID + App Certificate** from `.env.local`
> and mints RTC/RTM join tokens locally. The `agora login` browser step is a
> one-time **developer** action that fetches those credentials into `.env.local`;
> you can skip the CLI entirely and just paste the two values from
> [Agora Console](https://console.agora.io) → your project. The App ID/Certificate
> do **not** expire — but if you **switch Agora accounts or projects**, the old
> credentials become invalid and the agent fails to join with
> `401 Invalid token`; re-run `agora login && agora project env write .env.local`
> (or paste the new values) to fix it. (The CLI *login session* itself does expire
> periodically — re-run `agora login` if `agora` commands start failing auth.)

If the agent does not join or transcripts do not appear, run **`agora project doctor --deep`** to check credentials, feature enablement, network reachability, and local env binding.

### Working from a clone of this repository

Use this path if you already cloned **this** repo (for example to contribute or fork):

```bash
git clone https://github.com/AgoraIO-Conversational-AI/agent-quickstart-nextjs.git
cd agent-quickstart-nextjs
agora login
agora project use <your-project>
pnpm install
agora project env write .env.local
agora project doctor --deep
pnpm dev
```

### Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAgoraIO-Conversational-AI%2Fagent-quickstart-nextjs&project-name=agent-quickstart-nextjs&repository-name=agent-quickstart-nextjs&env=NEXT_PUBLIC_AGORA_APP_ID,NEXT_AGORA_APP_CERTIFICATE&envDescription=Agora%20credentials%20needed%20to%20run%20the%20app&envLink=https%3A%2F%2Fgithub.com%2FAgoraIO-Conversational-AI%2Fagent-quickstart-nextjs%23run-it&demo-title=Agora%20Conversational%20AI%20Next.js%20Quickstart&demo-description=Official%20Next.js%20quickstart%20for%20building%20browser-based%20voice%20AI%20with%20Agora&demo-image=https%3A%2F%2Fraw.githubusercontent.com%2FAgoraIO-Conversational-AI%2Fagent-quickstart-nextjs%2Fmain%2F.github%2Fassets%2FConversation-Ai-Client.gif)

To populate Vercel env vars from your bound Agora project:

```bash
agora project use <your-project>
agora project env write .env.local
rg "^(NEXT_PUBLIC_AGORA_APP_ID|NEXT_AGORA_APP_CERTIFICATE)=" .env.local
```

Copy those two values into Vercel Project Settings -> Environment Variables.

### Environment variables

Copy the committed template and fill in your own values:

```bash
cp .env.example .env.local
```

[`.env.example`](.env.example) is the source of truth — every variable the code
reads, grouped by purpose (A: the `/tutor` storybook tutor; B: the legacy
conversation quickstart; C: offline eval/bench) with required-vs-optional notes.
`.env.local` is gitignored and never committed.

The required minimum to run the **`/tutor` storybook tutor**:

| Variable                     | Required | Default  | Notes                                                                                          |
| ---------------------------- | :------: | :------: | ---------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_AGORA_APP_ID`   |    ✅    |    —     | Agora Console → Project → App ID.                                                              |
| `NEXT_AGORA_APP_CERTIFICATE` |    ✅    |    —     | Agora Console → Project → App Certificate. **Server-side only.**                               |
| `GOOGLE_API_KEY`             |    ✅    |    —     | [Gemini API key](https://aistudio.google.com/apikey). Drives all lesson generation + the resume planner. |
| `NEXT_PUBLIC_AGENT_UID`      |          | `123456` | Must match the `agentUid` in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts). |
| `NEXT_AGENT_GREETING`        |          |    —     | Override the agent's opening line.                                                             |

Legacy-quickstart BYOK keys (Deepgram / OpenAI-compatible LLM / ElevenLabs) and
offline-bench keys are documented in [`.env.example`](.env.example) — see also
[Optional BYOK](#optional-byok) below. The default agent config in
[`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts) uses
Agora-managed STT/LLM/TTS, so those vendor keys aren't needed for the base quickstart.

> **Default vs BYOK** — the quickstart ships with Agora-managed inference for a zero-key install. Switch to BYOK below when you need to bring your own provider quotas, models, or vendors.

## Commands

```bash
# Dev
pnpm dev                # start the Next.js dev server

# Quality
pnpm run lint           # eslint
pnpm run typecheck      # tsc --noEmit
pnpm run doctor         # local prereqs + env binding

# CI / pre-ship
pnpm run verify:api     # API contract checks
pnpm run build          # production build
pnpm run verify         # doctor + lint + typecheck + verify:api + build
```

Run `pnpm run verify` before shipping changes — it covers local prerequisites, lint, type safety, the core API route contracts, and the production build.

## Evaluation & tests

The tutor is verified at four layers, cheapest first. Layers 1–3 need no Agora
session; layer 4 drives a real one.

```bash
# 1. Unit tests (free, deterministic) — language detection, transcript
#    attribution + barge-in Q&A filtering, the shared system-message builder.
pnpm test

# 2. Voice-AI Q&A bench (needs GOOGLE_API_KEY; ~10s) — runs the REAL persona
#    through a proxy model across 8 interrupt types × 3 stories × 2 languages
#    (answer-vs-tease, no-spoiler, off-topic deflect, stay-in-character, brevity).
pnpm tsx scripts/voice-qa-bench/comprehensive.ts --trials 3   # add --with-claude for cross-model

# 3. Session-log grader — LLM-grades real logs/sessions/*.txt, so any manual
#    /tutor test you run becomes a graded eval data point.
pnpm tsx scripts/session-eval/grade-logs.ts

# 4. Audio barge-in e2e (needs a running dev server + Agora; macOS `say` + ffmpeg)
#    — fake-mics a spoken question during narration and reads the real agent's
#    answer back from the session log.
node scripts/qa-bench/audio-barge-in/cat-name-e2e.mjs
```

The QA-resume planner has its own benchmark + grader — see
[`scripts/qa-bench/README.md`](scripts/qa-bench/README.md).

## Legacy conversation demo

> The sections below (Architecture, What You Get, How It Works, Optional BYOK,
> Troubleshooting) document the **original Agora conversation quickstart** — the
> plain voice-chat demo at `/`. The storybook tutor at `/tutor` is described in
> [How it works (the storybook tutor)](#how-it-works-the-storybook-tutor) above.
> Both ship in this repo and share the Agora token + RTC/RTM plumbing.

### Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./system-architecture-dark.svg">
  <img src="./system-architecture.svg" alt="System architecture">
</picture>

The browser fetches a combined RTC + RTM token (`buildTokenWithRtm`) from this app, joins the channel using a single RTC client, and uses RTM as the data channel for transcript, agent state, metrics, and error events. The Conversational AI Engine joins the same channel as the configured `NEXT_PUBLIC_AGENT_UID` and runs the STT → LLM → TTS pipeline in Agora Cloud.

### What You Get

- browser voice client built with Next.js App Router
- RTC audio plus RTM transcript and state events
- server routes for token generation, invite, and stop
- [`AgentVisualizer`](https://agoraio-conversational-ai.github.io/agent-uikit/) for agent state and a built-in transcript panel for live turns
- per-stage latency header driven by `AGENT_METRICS`
- Agora-managed default STT, LLM, and TTS configuration

### How It Works

1. The browser requests an RTC + RTM token from `/api/generate-agora-token`.
2. The backend invites an Agora cloud agent with `/api/invite-agent`.
3. The browser joins the channel and publishes mic audio.
4. The client receives transcript, agent state, and `AGENT_METRICS` (per-stage latency) events over RTM.
5. On end, the client unpublishes and stops the local microphone track, then calls `/api/stop-conversation` to terminate the agent session.

### Optional BYOK

The quickstart defaults to Agora-managed inference. To bring your own keys, uncomment the matching blocks in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts) and add the corresponding env vars.

```bash
# Deepgram STT
NEXT_DEEPGRAM_API_KEY=...

# OpenAI-compatible LLM
NEXT_LLM_URL=https://api.openai.com/v1/chat/completions
NEXT_LLM_API_KEY=...

# ElevenLabs TTS
NEXT_ELEVENLABS_API_KEY=...
NEXT_ELEVENLABS_VOICE_ID=...
```

## Repo Map

**Storybook tutor (`/tutor` — the main app):**

- `app/tutor/page.tsx` — the tutor route
- `components/TutorPage.tsx` — client orchestration: SSE pipeline, Agora RTC/RTM, barge-in detection, mic
- `components/tutor/` — UI screens (`InputScreen`, `LoadingScreen`, `StoryScreen`) + theme/ornaments
- `app/api/lesson/start/route.ts` — SSE: compose lesson → generate images/videos → start session
- `app/api/tutor/qa-ended/route.ts` — barge-in resume trigger (bridge + rescript)
- `lib/lesson/` — lesson generation: scene composition, image-gen, video-gen, `script-generator.ts` (incl. input-language detection)
- `lib/orchestrator/` — the deterministic spine: `progress-state.ts` (source of truth),
  `narrator.ts`, `resume-planner.ts` (single-shot resume brain), `session-logger.ts` (debug log)
- `lib/language-config.ts` — per-language persona + the shared `buildStorytellerSystemMessage` (single source of truth for the agent's runtime context, used by both prod and the bench)
- `components/tutor/transcript-mapping.ts` — pure user/agent transcript attribution + barge-in Q&A filtering (unit-tested)
- `docs/experiments/` — data-backed decisions (agentic-vs-singleshot, climax-leak, typed-segment, …)
- `scripts/qa-bench/` — offline eval: the qa-resume benchmark + grader + audio barge-in harness
- `scripts/voice-qa-bench/` — prod-faithful voice-AI Q&A bench (8 interrupt types × stories × languages)
- `scripts/session-eval/` — LLM-grades real `logs/sessions/*.txt` so manual tests become eval data
- `scripts/probes/` — live Agora probes (does `say()` feed context; does `session.update` work)

**Legacy conversation demo (`/`):**

- `app/api/generate-agora-token/route.ts` — issues RTC + RTM tokens (shared by both)
- `app/api/invite-agent/route.ts` — starts the agent session and configures the pipeline
- `app/api/stop-conversation/route.ts` — stops the agent session
- `components/LandingPage.tsx` — entry point: token fetch, RTM login, conversation lifecycle
- `components/ConversationComponent.tsx` — RTC client, transcript state, `AGENT_METRICS`, mic release
- `components/Quickstart*.tsx` — conversation layout, latency chips, transcript rail, pre-call card
- `lib/conversation.ts` — transcript normalization and visualizer state mapping
- `AGENTS.md` — primary agent-facing guide

### Troubleshooting

- **Agent does not join or transcripts are missing:** run `agora project doctor --deep`.
- **`401 Invalid token` (lesson starts, images/videos load, then errors at session start):** the Agora App ID/Certificate in `.env.local` belong to a different/old account or project. Re-run `agora login && agora project use <project> && agora project env write .env.local` (or paste the current project's App ID + Certificate from [Agora Console](https://console.agora.io)), then restart the dev server. If `env write` errors with a stale "Project … not found", delete `.agora/project.json` and re-bind with `agora project use`.
- **`pnpm run doctor` fails:** run `agora project env write .env.local`, then retry.
- **Manual clone / env values:** `agora project use <your-project>` then `agora project env write .env.local`.
- **RTM login fails:** keep [`app/api/generate-agora-token/route.ts`](app/api/generate-agora-token/route.ts) on `RtcTokenBuilder.buildTokenWithRtm` — RTC-only tokens will not satisfy `rtm.login`.
- **Transcript speakers inverted:** check the `uid === "0"` remap in [`components/ConversationComponent.tsx`](components/ConversationComponent.tsx).
- **Agent never appears in channel:** ensure `NEXT_PUBLIC_AGENT_UID` matches the value used in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts).

## Building with an AI assistant

This quickstart follows Agora's standard setup conventions — credentials from
[Agora Console](https://console.agora.io) (App ID + App Certificate) with the
`agora` CLI automating env export, and tokens minted server-side from the App
Certificate. If you build with an AI coding assistant (Claude Code, Cursor,
Windsurf, Copilot), install the official **[AgoraIO/skills](https://github.com/AgoraIO/skills)**
knowledge pack — it teaches the assistant product selection, credential setup,
and running demos against the live Agora platform.

## More Docs

- [AGENTS.md](./AGENTS.md) — primary agent-facing guide to the codebase
- [AgoraIO/skills](https://github.com/AgoraIO/skills) — official Agora skill pack for AI coding assistants
- [docs/proactive-tutor-engine-prd.md](./docs/proactive-tutor-engine-prd.md) — the storybook tutor product/engine spec
- [docs/experiments/](./docs/experiments) — data-backed design decisions (agentic-vs-singleshot, climax-leak, …)
- [scripts/qa-bench/README.md](./scripts/qa-bench/README.md) — the offline QA-resume benchmark
- [scripts/qa-bench/audio-barge-in/README.md](./scripts/qa-bench/audio-barge-in/README.md) — the fake-mic audio barge-in harness

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and conventions.

## Security

Please do **not** open public issues for security reports. Email security@agora.io with details and reproduction steps.

## License

Released under the [MIT License](./LICENSE).

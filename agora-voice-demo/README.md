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

## How it works (the storybook tutor)

The architecture is **two LLM roles + a deterministic spine** (a "proposer / disposer"
pattern), NOT an agentic tool loop — a choice [validated with data](docs/experiments/2026-05-29-agentic-vs-singleshot/conclusion.md)
(agentic was equal quality at ~3.6× latency, ~5× tokens).

1. **Generate** — a Gemini pass composes the lesson: scenes, narration script,
   one illustration + short "draw-on" video per scene ([`lib/lesson/`](lib/lesson)).
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

3. Open [http://localhost:3000](http://localhost:3000) and click **Start conversation**.

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
- `lib/lesson/` — lesson generation: scene composition, image-gen, video-gen, script-generator
- `lib/orchestrator/` — the deterministic spine: `progress-state.ts` (source of truth),
  `narrator.ts`, `resume-planner.ts` (single-shot resume brain), `session-logger.ts` (debug log)
- `docs/experiments/` — data-backed decisions (agentic-vs-singleshot, climax-leak, typed-segment, …)
- `scripts/qa-bench/` — offline eval: the qa-resume benchmark + grader + audio barge-in harness

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
- **`pnpm run doctor` fails:** run `agora project env write .env.local`, then retry.
- **Manual clone / env values:** `agora project use <your-project>` then `agora project env write .env.local`.
- **RTM login fails:** keep [`app/api/generate-agora-token/route.ts`](app/api/generate-agora-token/route.ts) on `RtcTokenBuilder.buildTokenWithRtm` — RTC-only tokens will not satisfy `rtm.login`.
- **Transcript speakers inverted:** check the `uid === "0"` remap in [`components/ConversationComponent.tsx`](components/ConversationComponent.tsx).
- **Agent never appears in channel:** ensure `NEXT_PUBLIC_AGENT_UID` matches the value used in [`app/api/invite-agent/route.ts`](app/api/invite-agent/route.ts).

## More Docs

- [DOCS/GUIDE.md](./DOCS/GUIDE.md)
- [DOCS/TEXT_STREAMING_GUIDE.md](./DOCS/TEXT_STREAMING_GUIDE.md)
- [AGENTS.md](./AGENTS.md)

## Contributing

Pull requests welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and conventions.

## Security

Please do **not** open public issues for security reports. Email security@agora.io with details and reproduction steps.

## License

Released under the [MIT License](./LICENSE).

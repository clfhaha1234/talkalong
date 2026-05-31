# Deploying talkalong (/tutor)

## Vercel (current target) — status + the 2 steps only you can do

The app is **deployed to Vercel** and all code/config deploy-blockers are fixed:
- function size (was 571MB — a stale 589MB `public/lesson-cache` of local dev
  mp4s got traced into the lambda; now excluded via `.vercelignore` +
  `outputFileTracingExcludes`)
- `maxDuration` lowered 1200→**800** (Vercel Pro's hard ceiling)
- `outputFileTracingRoot` pinned to this dir (subdir-app safety)

Latest preview: `https://agora-voice-demo-*.vercel.app` (`vercel deploy`).

**Two remaining steps are yours** (I'm not permitted to do either — security
setting + secret keys):

1. **Turn off Deployment Protection** (or add a bypass) — Vercel project →
   Settings → Deployment Protection. Until then every URL returns `401
   Authentication Required`.
2. **Set the env vars** — Vercel project → Settings → Environment Variables,
   add all four from `.env.example` (`NEXT_PUBLIC_AGORA_APP_ID`,
   `NEXT_AGORA_APP_CERTIFICATE`, `GOOGLE_API_KEY`, `NEXT_PUBLIC_AGENT_UID`) to
   **Production + Preview**. The `NEXT_PUBLIC_*` ones are inlined **at build
   time**, so a **redeploy is required after setting them** (`vercel deploy`).

### Known Vercel runtime limits (the serverless tradeoffs)

- **Illustrations**: `public/` is read-only on Vercel, so `image-gen`'s
  disk-write fails *soft* → scenes show the "sketching" placeholder, not a
  generated image. The story still narrates. To get real illustrations on
  Vercel, move image storage to **Vercel Blob** (a contained change to
  `image-gen.ts` + a Blob store) — not yet done.
- **Narration length**: capped at 800s/session. Fine for 3–5 scene stories; a
  much longer session would be cut off.
- **Barge-in across requests**: the in-memory session registry assumes one
  process; serverless may route `branch-started`/`qa-ended` to a different
  instance. Verify barge-in once env is set; if flaky, it needs a durable
  store (KV).

**A persistent Node host (below) has none of these limits** — it's the option
for full fidelity. Vercel is fine for a UI/demo + short-story narration.

## Alternative — a persistent Node host (full functionality, no limits)

talkalong's `/tutor` is a **stateful, long-running orchestrator**, not a
serverless workload:

- a single narration session can run for **minutes** (the `/api/lesson/start`
  SSE stays open the whole time; `maxDuration` is 1200s)
- it keeps an **in-memory session registry** so `branch-started` / `qa-ended`
  can find the live session — this needs one process, not many lambdas
- it **writes generated images to `public/lesson-cache/` at runtime** and serves
  them from disk

On Vercel serverless this builds fine but breaks at runtime (function timeout
cuts narration off, runtime-written images 404 from the CDN, the registry misses
across instances). So deploy it as a **plain Node server (`next start`) on a
persistent host**: Render / Railway / Fly / a VM. There, every one of those
"blockers" is a non-issue.

The production build is verified green (`pnpm build` → exit 0) and `next start`
serves `/tutor`.

---

## Required environment variables

Set these in your host's dashboard (see `.env.example` for the annotated list):

| var | what |
|---|---|
| `NEXT_PUBLIC_AGORA_APP_ID` | Agora project App ID (console.agora.io) |
| `NEXT_AGORA_APP_CERTIFICATE` | Agora App Certificate (token signing) |
| `GOOGLE_API_KEY` | Gemini — script/scene/image generation + resume planner |
| `NEXT_PUBLIC_AGENT_UID` | agent RTC uid (default `123456`) |

The STT/LLM/TTS vendor keys (Deepgram / OpenAI / MiniMax) live in the **Agora
project dashboard**, not here — the app only mints tokens + invites the agent.

---

## Option A — Render (recommended, blueprint included)

A `render.yaml` blueprint sits at the **repo root**. It builds the app from
`agora-voice-demo/Dockerfile`.

1. Push to GitHub (already there).
2. Render → **New → Blueprint** → pick this repo. It reads `render.yaml`.
3. Fill the three secret env vars (`NEXT_PUBLIC_AGORA_APP_ID`,
   `NEXT_AGORA_APP_CERTIFICATE`, `GOOGLE_API_KEY`) when prompted.
4. Deploy. Health check is `/tutor`. You get a public `https://…onrender.com`.

(No Dockerfile knowledge needed — the blueprint wires it. Render injects `$PORT`;
`next start` binds it automatically.)

## Option B — Railway

New Project → Deploy from repo → set **Root Directory = `agora-voice-demo`**.
Railway auto-detects the Dockerfile (or pnpm). Add the env vars. Railway injects
`$PORT`; `next start` uses it.

## Option C — Fly.io / any Docker host

```bash
cd agora-voice-demo
docker build -t talkalong .
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_AGORA_APP_ID=… \
  -e NEXT_AGORA_APP_CERTIFICATE=… \
  -e GOOGLE_API_KEY=… \
  -e NEXT_PUBLIC_AGENT_UID=123456 \
  talkalong
```

`fly launch` from `agora-voice-demo/` will detect the Dockerfile; set the same
env vars via `fly secrets set`.

---

## What works vs. what's deferred in this container

**Works:** lesson generation, scene **images** (Gemini → `public/lesson-cache`,
served from disk), the full narration → barge-in → QA → Chinese-resume loop,
typed questions.

**Deferred — video rendering.** The Ken-Burns clips are rendered by **Remotion,
which lives in the repo ROOT** (one level up from this app) and needs headless
Chromium. The slim container ships only the Next app, so `video-gen` "fails
soft" and the UI shows the **still illustration** instead (which is what most
scenes display anyway). To enable video later: build an image whose context is
the repo root, install the root project's deps + a Chromium for Remotion, and
ensure `video-gen`'s `parentProjectDir` points at it. That's a heavier image —
treat it as a v2.

---

## Local production sanity check

```bash
cd agora-voice-demo
pnpm build
PORT=3200 pnpm start    # serves http://localhost:3200/tutor
```

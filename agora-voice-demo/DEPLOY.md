# Deploying talkalong (/tutor)

## Vercel (current target) — LIVE & PUBLIC

The app is **deployed and public** on Vercel:

- **Stable URL: <https://agora-voice-demo.vercel.app>** (`/` 307-redirects to
  `/tutor` via `next.config.mjs`). Project `arclow/agora-voice-demo` (Pro).
- Deploy a new prod build with `vercel --prod --scope arclow` from this dir.
  (GitHub auto-deploy is **not** wired — deploys are manual CLI.)

All code/config deploy-blockers are fixed:

- **function size** (was 571MB — a stale 589MB `public/lesson-cache` of local
  dev mp4s got traced into the lambda; now excluded via `.vercelignore` +
  `outputFileTracingExcludes`)
- **`maxDuration`** lowered 1200→**800** (Vercel Pro's hard ceiling)
- **`outputFileTracingRoot`** pinned to this dir (subdir-app safety)
- **read-only-FS crash**: `script-generator.ts` and `image-gen.ts` used to write
  caches under `public/lesson-cache/` and threw `ENOENT: mkdir` on Vercel's
  immutable FS, killing the whole lesson. Both now **fail soft** (try/catch →
  cache miss / Blob path).

Two manual steps were required and are **done** (they're yours to redo if you
re-provision the project — I can't toggle a security setting or enter secrets):

1. ✅ **Deployment Protection is off** — Settings → Deployment Protection. (If a
   redeploy ever returns `401 Authentication Required`, this got re-enabled.)
2. ✅ **Env vars set** on **Production + Preview**: `NEXT_PUBLIC_AGORA_APP_ID`,
   `NEXT_AGORA_APP_CERTIFICATE`, `GOOGLE_API_KEY`, `NEXT_PUBLIC_AGENT_UID`
   (+ `BLOB_READ_WRITE_TOKEN`, auto-injected when the Blob store was linked).
   The `NEXT_PUBLIC_*` ones are inlined **at build time**, so changing them
   **requires a redeploy** (`vercel --prod`).

### Illustrations on Vercel = Vercel Blob (done)

`public/` is read-only on Vercel **and** runtime-written files aren't served by
the CDN — so the local filesystem image cache can't work there. `image-gen.ts`
detects Vercel by `process.env.BLOB_READ_WRITE_TOKEN` and, when present, uploads
each generated JPEG to the **Vercel Blob** store (`put()` with
`addRandomSuffix:false` + `allowOverwrite:true`, deterministic
`lesson-cache/<hash>.jpg`) and returns the CDN URL. Locally / on a persistent
host the same function falls back to the disk cache + Remotion video path.

> ⚠️ **Gotcha — `vercel blob create-store` / `delete-store` clobbers
> `.env.local`.** Those commands silently run `vercel env pull` and overwrite the
> local file with the *development* env, **dropping** any Sensitive (write-only)
> keys that were only set for Production/Preview — which breaks local dev + the
> fake-mic e2e. Back up `.env.local` before running any `vercel blob` store
> command and restore after. (Recorded in agent memory `vercel-blob-env-clobber`.)
>
> 💰 **Cost follow-up (not yet done):** the Blob path has **no read-before-write
> check**, so it re-generates + re-uploads (a paid Gemini call) on every run even
> for an identical hash. Add a `head()`/`list()` cache-hit short-circuit to match
> the disk path's free cache hits.

### Other Vercel runtime limits (the serverless tradeoffs)

- **Narration length**: capped at 800s/session. Fine for 3–5 scene stories; a
  much longer session would be cut off.
- **Barge-in across requests**: the in-memory session registry assumes one
  process; serverless *may* route `branch-started`/`qa-ended` to a different
  instance. Observed working on the live deploy, but under load it could miss —
  if flaky, move the registry to a durable store (KV).
- **Video**: Ken-Burns clips need Remotion (repo root, headless Chromium); not in
  the Vercel build, so scenes show the still illustration (see below).

**A persistent Node host (below) has none of these limits** — it's the option
for full fidelity (incl. video). Vercel is the live public demo.

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
| `GOOGLE_API_KEY` | Gemini — script/scene/image generation, resume planner, **and the live voice agent's Q&A LLM** (via Gemini's OpenAI-compatible endpoint; Agora's bundled OpenAI reseller 401s on this project — see [postmortem](docs/postmortem-2026-06-01-qa-no-answer.md)) |
| `GEMINI_TUTOR_MODEL` | Optional — override the agent's Q&A model (default `gemini-3.1-flash-lite`) |
| `NEXT_PUBLIC_AGENT_UID` | agent RTC uid (default `123456`) |
| `LESSON_CACHE_DIR` | Optional persistent cache directory for scripts/images, e.g. `/var/data/lesson-cache` on a Render disk |

The **STT (Deepgram)** and **TTS (MiniMax)** vendor keys live in the **Agora
project dashboard** (managed reseller) — the app only mints tokens + invites the
agent. The **LLM is the exception**: the agent is configured to call **Gemini**
with `GOOGLE_API_KEY` from this app, *not* the Agora OpenAI reseller (which 401s
here). So `GOOGLE_API_KEY` is the one credential that must be valid for the agent
to actually answer questions.

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

## What works in the Render container

**Works:** lesson generation, scene **images** (Gemini → `LESSON_CACHE_DIR` if
set, else `public/lesson-cache`, served from disk), the full narration →
barge-in → QA → Chinese-resume loop, typed questions.

**Video rendering is packaged but opt-in on Render.** The Docker context is the
repo root, so the image contains both the Remotion project (`/app`) and the
Next app (`/app/agora-voice-demo`). `video-gen` can preprocess generated
illustrations with the root Remotion pipeline and serve clips through
`/api/lesson-video/<hash>`, but `LESSON_VIDEO_RENDERING=0` by default because
headless Chromium can OOM the 512MB Starter web instance. Enable it only after
moving video rendering to a larger instance or a dedicated worker.

---

## Local production sanity check

```bash
cd agora-voice-demo
pnpm build
PORT=3200 pnpm start    # serves http://localhost:3200/tutor
```

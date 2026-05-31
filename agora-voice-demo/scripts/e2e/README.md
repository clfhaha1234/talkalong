# Tutor UI test layers

Most bugs found by hand on `/tutor` lived in the **live-UI layer** (composer
visibility, feed scroll, chapter pinning under the ScalingStage transform, the
voice/keyboard toggle, duplicate live bubble). For a long time the only test of
that layer was a human clicking around. These layers close that gap, cheapest
first.

| Layer | Tool | What it covers | Needs a live session? | Where |
|---|---|---|---|---|
| **Unit / logic** | vitest (node) | transcript mapping, reveal-sync, orchestrator branch logic, STT config, lesson pipeline | no | `lib/**`, `components/**/*.test.ts` |
| **Tier 1 — component render** | vitest (jsdom) + testing-library | StoryScreen across every phase (reading/paused/listening/thinking) + finished/micDenied/QA-answer-bubble/scene-dots + toggle + no-dup-bubble; InputScreen (topic/presets/Begin wiring); LoadingScreen (SSE step progression) | no | `components/tutor/*.render.test.tsx` |
| **Tier 2 — browser layout smoke** | Playwright (lib) | REAL-browser geometry jsdom can't see: composer within viewport across **5 state variants** (reading/muted/listening/paused/finished), feed scrollable, toggle in a real DOM — driven against `/tutor/preview` (StoryScreen + fixtures, no Agora) | no | `tutor-storyscreen-smoke.mjs`, `tutor-input-smoke.mjs` |
| **Tier 3 — full session** *(not built)* | Playwright + fake-mic + live Agora/LLM | the real STT/barge-in/say()-injection round trip | **yes — keys + credits** | see below |

## Running

```bash
# Everything, one command (boots its own dev server if none is up):
pnpm eval                       # vitest (node+jsdom) + both browser smokes
E2E_BASE_URL=http://localhost:3000 pnpm eval   # reuse a running server
pnpm eval --no-e2e              # vitest only (skip the browser layer)

# Or each layer on its own:
pnpm test                       # node + jsdom vitest projects
pnpm vitest run --project jsdom # just the render tests
pnpm dev & E2E_BASE_URL=http://localhost:3000 pnpm test:e2e  # browser smokes
```

`/tutor/preview` is a dev/test-only route (server component reads `?variant=`,
client half supplies the no-op handlers — no hydration mismatch): it mounts
StoryScreen with canned fixtures inside the same `ScalingStage` wrapper the real
tutor uses, with no Agora / API / mic. Variants:
`?variant=reading|muted|listening|paused|finished`.

## Tier 3 — full fake-mic session (BUILT, opt-in, costs credits)

`scripts/qa-bench/audio-barge-in/tutor-barge-in-e2e.mjs` (`pnpm test:e2e:live`)
drives the REAL /tutor flow in headless Chromium with a **fake microphone**:
it enters a topic, lets the real agent (Agora ConvoAI: Deepgram STT →
gpt-4o-mini → MiniMax TTS) narrate a cat story, plays the spoken question
*"What is the name of the cat?"* during narration, and reads the agent's real
spoken answer from the server-side session log. It asserts the agent **names the
cat** (a name from the narration) instead of teasing — proving barge-in fired
from real audio, the branch paused narration, and the say()-injected context
reached the LLM.

It is **NOT** in `pnpm eval` / CI on purpose: it needs a dev server with live
Agora credentials, macOS `say` + ffmpeg for the WAV, and it spends real
LLM/TTS/compose credits (~one cat story per run, ~2–3 min wall-clock).

```bash
pnpm dev &                       # dev server with .env.local credentials
pnpm test:e2e:live               # or: TUTOR_URL=… OBSERVE_MS=… node …/tutor-barge-in-e2e.mjs
```

Verified PASS 2026-05-30: heard the question, answered "The cat's name is
Pemberley…", named the cat, did not tease. (The older `cat-name-e2e.mjs` in the
same dir predates the always-on-mic rework — it waits for a `turn on microphone`
button that no longer exists; `tutor-barge-in-e2e.mjs` is the current one,
keyed off the `scene-dots` testid.)

Still genuinely out of headless reach (and covered another way): barge-in
**latency** distribution (the fake-mic latency harness `run-latency.mjs`) and
the orchestrator branch/resume **logic** (`index.qa-resume.test.ts` +
`stt-config.test.ts`, which also pin the config against drift).

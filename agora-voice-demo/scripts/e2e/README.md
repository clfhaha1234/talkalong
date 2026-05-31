# Tutor UI test layers

Most bugs found by hand on `/tutor` lived in the **live-UI layer** (composer
visibility, feed scroll, chapter pinning under the ScalingStage transform, the
voice/keyboard toggle, duplicate live bubble). For a long time the only test of
that layer was a human clicking around. These layers close that gap, cheapest
first.

| Layer | Tool | What it covers | Needs a live session? | Where |
|---|---|---|---|---|
| **Unit / logic** | vitest (node) | transcript mapping, reveal-sync, orchestrator branch logic, STT config | no | `lib/**`, `components/**/*.test.ts` |
| **Tier 1 — component render** | vitest (jsdom) + testing-library | StoryScreen markup given props: composer present, toggle switches, feed renders narrated scenes, no duplicate live bubble | no | `components/tutor/StoryScreen.render.test.tsx` |
| **Tier 2 — browser layout smoke** | Playwright (lib) | REAL-browser geometry jsdom can't see: composer within viewport, feed scrollable, toggle in a real DOM — driven against `/tutor/preview` (StoryScreen + fixtures, no Agora) | no | `tutor-storyscreen-smoke.mjs`, `tutor-input-smoke.mjs` |
| **Tier 3 — full session** *(not built)* | Playwright + fake-mic + live Agora/LLM | the real STT/barge-in/say()-injection round trip | **yes — keys + credits** | see below |

## Running

```bash
# Tier 1 (fast, in the normal suite):
pnpm test                       # runs node + jsdom vitest projects
pnpm vitest run --project jsdom # just the render tests

# Tier 2 (needs a dev server up):
pnpm dev &                      # or point at any running instance
E2E_BASE_URL=http://localhost:3000 pnpm test:e2e
```

`/tutor/preview` is a dev/test-only route: it mounts StoryScreen with canned
fixtures inside the same `ScalingStage` wrapper the real tutor uses, with no
Agora / API / mic. Query flags: `?muted=1`, `?branch=1`, `?live=<text>`.

## Tier 3 is deliberately deferred (not a silent gap)

The full barge-in / STT / Chinese-resume round trip needs live Agora RTC/RTM, a
real microphone, and paid LLM+TTS calls — it can't run headless in CI and burns
credits per run. That round trip is covered another way today:

- **orchestrator logic** by `lib/orchestrator/index.qa-resume.test.ts` +
  `stt-config.test.ts` (the config can't silently drift from the proven `/` demo)
- **barge-in latency** by the opt-in fake-mic harness in
  `scripts/qa-bench/audio-barge-in/` (run manually against a live dev server)

If/when Tier 3 is built, it belongs here as an opt-in script gated behind an
env flag (keys present), never in the default `test`/CI path.

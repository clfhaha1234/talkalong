# Audio barge-in MVP — the missing audio layer of the bench

The offline bench (PASS/FAIL on 79 content cases) **cannot** test:
- whether Agora's VAD treats a cough / "uh huh" / silence as a real interrupt
- whether AEC silently swallows the listener's audio
- whether STT mis-transcribes under noise

This sub-bench closes that gap with a Chromium + fake-mic harness, proven feasible by [docs/experiments/2026-05-30-fake-mic-spike/](../../../docs/experiments/2026-05-30-fake-mic-spike/) (all 4 spikes PASS).

MVP scope: 3 cases. Real first-run finding: **FBR (false barge-in rate) = 50%** — Agora's managed default treats "uh huh" as a real interrupt, silence correctly does not. Expanding the case set will give per-noise-class FBR.

## Cases (locked 2026-05-30)

| id | label | axis | what the audio is | what we look for |
|---|---|---|---|---|
| B01 | `barge-in-true-question` | `true-positive` | TTS "What is moss?" | STT receives + agent replies post-greeting |
| B02 | `barge-in-back-channel` | `false-positive-risk` | TTS "uh huh" | Observed and recorded (no gating — the FBR KPI reads this) |
| B03 | `barge-in-silence-only` | `false-positive-clean` | 30s pure silence | No STT events + no post-greeting agent turn |

Each WAV follows the **pad-don't-loop** pattern (5s lead silence + content + 60s trail silence) — verified necessary by the fake-mic spike (looping WAV confused the agent's LLM context).

## Pre-flight

```bash
# 1. Dev server must be running.
pnpm dev    # in agora-voice-demo. Wait for "Ready in Xs"

# 2. Generate the test WAVs (~5s, needs macOS `say` + ffmpeg).
node scripts/qa-bench/audio-barge-in/generate-wavs.mjs
```

## Run

```bash
node scripts/qa-bench/audio-barge-in/run.mjs
# or a subset:
node scripts/qa-bench/audio-barge-in/run.mjs --only B01,B03
```

Per-case: one headless Chromium launch (~50s observation window). 3 cases → ~3 minutes total. Writes `/tmp/spike-mic/barge-in/graded.json` (same shape as `scripts/qa-bench/grade.ts` output) and prints a markdown verdict table + the FBR KPI.

## Latency + quality (`run-latency.mjs`)

`run.mjs` answers *did the barge-in fire correctly?* `run-latency.mjs` answers *how fast, and how good?* — the two layers the MVP list below called out as missing.

```bash
node scripts/qa-bench/audio-barge-in/run-latency.mjs --only B01 --trials 3
node scripts/qa-bench/audio-barge-in/run-latency.mjs --judge          # + LLM quality score
```

It measures three latencies a listener actually feels, by polling the **user-visible DOM** (Voice Orb copy + branch overlay + "now reading" header) every 100ms — no app instrumentation, it tests the same surface the child sees:

| metric | gap measured | "feels like" |
|---|---|---|
| **T1** interrupt → pause | question audio onset → story pauses | how fast it stops talking when you speak |
| **T2** pause → reply | pause → answer text appears | how fast it answers |
| **T3** reply → resume | answer done → narrator resumes main line | how fast it gets back to the story |

`--trials N` repeats each case and reports **p50/p95** (VAD/LLM latency is non-deterministic — single-shot numbers mislead). `--judge` adds a 0–5 quality score on the spoken answer via `GOOGLE_API_KEY` (warm / correct / concise / returns to the tale). Interrupt onset is taken from the WAV's lead silence, validated deterministic to ±6ms by the [fake-mic spike](../../../docs/experiments/2026-05-30-fake-mic-spike/) (Spike 2).

The pure latency math (`deriveLatencies`, percentiles) is unit-tested on synthetic timelines; the **full run needs a dev server with real Agora + LLM keys** (this worktree has none — same constraint as `run.mjs`).

## KPIs

- **IRSR (Interrupt-Recovery Success Rate)** — same as offline bench: `n_pass / n_cases`. Cases here are mostly audio-correctness, not recovery — so for this sub-bench treat IRSR as `audio-pipeline-correctness rate`.
- **FBR (False Barge-In Rate)** — `n_false_positive_triggered / n_false_positive_cases`. The headline metric. A well-tuned barge-in stack should be near 0%. **Current baseline = 50%** (1/2 non-speech cases triggered a turn).

## What this MVP doesn't yet do

- Auto-start the dev server. (Assumes user has one running.)
- Trial repetition for VAD variance. (`--trials N` is post-MVP.)
- Real human-recorded noise samples (coughs, baby cries, TV background). MVP uses synthesized "uh huh" + silence; expanding the case set is the obvious next PR.
- Parallel case execution. Sequential for now (~50s per case).
- Latency metrics (interrupt-to-state-change, state-change-to-reply). Just pass/fail for MVP.

## Files

```
scripts/qa-bench/audio-barge-in/
  README.md           ← this file
  cases.json          ← 3 cases, locked 2026-05-30
  generate-wavs.mjs   ← macOS `say` + ffmpeg → padded WAVs
  run.mjs             ← per-case Playwright launch + assertions + FBR KPI
```

WAVs land in `/tmp/spike-mic/barge-in/<case_id>.wav`. Grader output at `/tmp/spike-mic/barge-in/graded.json`.

## Expanding the case set — easy path

Each new case is one JSON entry + one regenerate of the WAVs:

```json
{
  "id": "B04",
  "label": "barge-in-cough",
  "axis": "false-positive-risk",
  "audio_source": { "type": "external_wav", "path": "/path/to/cough.wav" },
  "expected": {
    "stt_received_final": false,
    "_note": "cough should not be transcribed; if it is, FBR rises"
  }
}
```

(The `external_wav` source type isn't wired in `generate-wavs.mjs` yet — when the first real-noise case lands, add a branch that copies the source file through the padding pipeline.)

## How this fits with the rest of the bench

| Layer | What it tests | When to run |
|---|---|---|
| `scripts/qa-bench/` (this directory's sibling, 79 cases) | **Content** — what the planner says | every PR change to persona / planner prompts |
| `scripts/qa-bench/audio-barge-in/` (this MVP, 3 cases) | **Audio pipeline** — fake-mic → SDK → STT → agent | weekly; before any audio-layer change |
| `scripts/e1/` (Agora SDK timing) | **Latency** — interrupt fidelity in ms | architecture choices |
| `scripts/qa-bench/e2e-interrupt.ts` | **Prod planner smoke** | before merging persona/planner prompt changes |
| Manual mic UAT | **Subjective seam quality, accents, noise resilience in the wild** | pre-ship; no substitute |

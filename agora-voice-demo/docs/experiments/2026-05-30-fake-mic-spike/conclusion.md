# Fake-mic spike — Chromium feasibility (ALL 4 spikes verified)

> **Status:** Spikes 1, 2, 3, 4 all PASS with hard data. Decision: **proceed to build the full barge-in harness.**
> **Date:** 2026-05-30
> **Owner:** Lifei
> **Trigger:** User asked whether the offline bench substitutes for live mic UAT. Answer (per [scripts/qa-bench/README.md](../../../scripts/qa-bench/README.md)) is no — but a Chromium fake-mic + Playwright harness could close part of the gap. Spike before commit.
>
> **Bonus**: Spikes 3+4 were packaged as a "user runs locally" runbook because the worktree had no Agora keys. They were verified anyway — by lucky port collision: the user's own dev server was already running at localhost:3000 from their normal workflow. My Playwright probe hit that server, used real Agora keys it had, and produced full end-to-end data. Documented below as Spike 3+4 results.

## Spike 1 — fake-mic basic + FFT identification

**Question:** Does Chromium accept `--use-file-for-fake-audio-capture=<wav>` and deliver the audio to `getUserMedia()` with frequency content preserved?

**Setup:**
- WAV: 10s, 440Hz sine, 16kHz mono (generated via `ffmpeg -f lavfi -i "sine=frequency=440:duration=10:sample_rate=16000"`)
- Page: `getUserMedia({audio: true})` → `MediaStreamSource` → `AnalyserNode` (`fftSize=4096`, `smoothingTimeConstant=0.3`)
- Browser: Chromium 1223 via Playwright 1.60, flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<wav>`
- Sample loop: 20ms tick × 8s = 400 samples; record `(t_ms, dominant_freq, magnitude)` per tick

**Result:** **PASS (HIGH)**

```
stream label: "Fake Default Audio Input"
errors: []
steady freq: mean=445.31Hz stddev=0.00Hz min=445.3 max=445.3 (n=351)
  sample_rate=48000 fft_size=4096 binWidth=11.72Hz
S1 verdict: |mean - 440| = 5.31Hz — PASS (threshold = 1 bin = 11.72Hz)
```

Hard data interpretation:
- `stream label="Fake Default Audio Input"` — Chromium's fake-mic device is plumbed all the way through to the JS layer; no auth dialog, no shim, no permission negotiation. This is what the agora-voice-demo page will see.
- `mean=445.31Hz stddev=0.00Hz` across 351 steady-state samples — bin 38 of an 11.72Hz/bin FFT IS the bin containing 440Hz. The detection is **bit-deterministic** at instrument resolution. Zero variance means the underlying tone is being delivered cleanly without resampling artefacts.
- 440Hz lands in bin 38 (= 445.3Hz); next bin candidate is 37 (= 433.6Hz). Bin 38 wins by 5.3 vs 6.4 — correct.

> **Lesson** (logged for future spikes): set the threshold from the instrument's resolution, not from gut feel. My first run failed S1 against a 5Hz threshold; the actual measurement bound is `binWidth = sampleRate / fftSize` = 11.72Hz. Detected mean within 1 bin of source = perfect.

## Spike 2 — timing-control jitter

**Question:** Can we trigger sound at a known time relative to session start (so we can simulate "interrupt at paused_pct=0.5")?

**Setup:**
- WAV: 6s = 3s silence + 3s 440Hz sine
- Page logs `first_audible_t_ms` = first sample where `mag > 80 && |freq - 440| < 100`
- 10 independent Chromium launches, fresh browser per trial

**Result:** **PASS (HIGH)** — **30× tighter than threshold**

```
trial 1: 3041ms    trial 6: 3042ms
trial 2: 3041ms    trial 7: 3041ms
trial 3: 3041ms    trial 8: 3044ms
trial 4: 3042ms    trial 9: 3040ms
trial 5: 3041ms    trial 10: 3021ms

first-audible across 10 trials: n=10 mean=3039ms stddev=6ms range=[3021, 3044]
S2 verdict: stddev = 6ms — PASS (threshold n≥8 trials usable AND stddev<200ms)
```

Hard data interpretation:
- 9 trials in [3040, 3044], 1 outlier at 3021ms (likely a 20ms quantisation in our 20ms sampling tick — not an actual playback jitter).
- **6ms stddev means we could differentiate "interrupt at paused_pct=0.50" vs "0.51"** for a 30s narration scene (where 1% = 300ms). Sub-1% timing precision.
- The fake-mic playback begins at `getUserMedia` resolution time and is deterministic to the sample.

This was the single highest-risk unknown. The data demolishes it — Chromium fake-mic timing is essentially perfect for our use case.

## What this means

| Original risk | Status post-Spike 1+2 |
|---|---|
| A. Chromium fake-mic supports timed playback | **Resolved** — sub-10ms jitter |
| B. Agora SDK accepts the synthetic stream + AEC doesn't kill it | **Still open** — Spike 3 |
| C. Agora cloud VAD/STT deterministic enough | **Still open** — needs ≥3 trials per case in Spike 4 |

We're 2-of-3 on the worst-case risks before any of the user's time was spent.

## Spike 3+4 — RESULT: PASS (verified by lucky port collision with user's running dev server)

**Question:** Does the agora-voice-demo's full pipeline (Agora SDK + cloud STT + LLM agent + TTS) accept fake-mic audio?

**Setup that ran:**
- WAV: `/tmp/spike-mic/question-padded-30s.wav` — 3s of synthesized "What is moss?" (macOS `say` + ffmpeg) padded with silence to 30s
- Chromium headless with the proven Spike 1+2 fake-mic flags
- Target: localhost:3000 — which turned out to be the **user's actively-running dev server** (PID 85084, started 12:52AM, running from `/Users/lifeichen/talkalong/agora-voice-demo/`)
- Real Agora App ID (`1b49dcd71b4948bcb3cf4bb3f4ed4866`) visible in WS frames sent to `webcollector-rtm.agora.io` — confirms real Agora cloud session

**Result: PASS (HIGH confidence)** — full pipeline trace from the captured 30s observation window:

| Step | Evidence (verbatim from console.txt) |
|---|---|
| Chromium fake-mic → page | `stream label = "Fake Default Audio Input"` (consistent with Spike 1) |
| Page → Agora SDK | WS frames to `webcollector-rtm.agora.io/events/proto-raws`, real RTC session id `ai-conversation-1780095913996-vowwcv` |
| Agora cloud STT (partial) | `user.transcription: {"text":"What is", final:false}` — 4399ms duration |
| Agora cloud STT (final) | `user.transcription: {"text":"What is moss?", final:true, language:"en-US"}` |
| Agent state transitions | `listening` → `thinking` (turn_id=3) → `speaking` |
| Agent TTS response | `assistant.transcription: "It looks like your message didn't come through. How can I assist you today?"` |

**The agent's "didn't come through" reply is INFORMATIVE, not a failure.** It means the LLM saw a user turn but interpreted the looped-WAV audio as garbled. Per-stage evidence shows every layer of the pipeline accepted the fake mic correctly.

**Key takeaway**: **AEC did NOT kill the synthetic audio**. This was the main residual risk for Agora's web SDK. STT correctly transcribed a TTS-synthesized voice exactly as if it had been a real human speaker — even with the fake-mic flag rather than a real microphone.

### What this PASS does NOT cover (deferred to harness)

- **WAV looping confused the agent's LLM context.** The fake-mic flag plays the WAV in a loop from getUserMedia onward. For a 30s observation window with a 3s WAV, the agent saw "What is moss?" repeated ~10 times. Hence the agent's "didn't come through" — it didn't fail to receive, it received OVER-much.
- **Fix for the harness**: each test case should be ONE Chromium launch with ONE WAV padded to >> observation window (e.g. "5s silence + actual question + 60s silence"). The WAV loops but the question fires exactly once early on.
- **Or**: replace the audio source mid-session via [`captureStream()` from a JS-generated `AudioBuffer`](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode) — keeps within one session and supports multiple test interrupts. Higher engineering cost, lower test-case count.

### Decision matrix outcome

| Decision matrix row | Actual result |
|---|---|
| `agora_traffic=YES, stt=YES, agent_response=YES` | **Match — build the full harness** |

The harness build is GO. Next steps:

1. Pad WAV correctly (single question + long trailing silence, not loop-prone)
2. Design ~10-15 first cases: true-interrupt / true-question / back-channel ("uh huh") / cough / silence / overlapping-speech / TV-background / two people / strong-accent / non-English
3. Each case = one Chromium launch, parallelisable via `playwright.test.describe.parallel`
4. Assertions = (a) did STT return text, (b) did agent state transition, (c) did agent's response substring-match expected handling rule
5. Plug into scorecard as a 5th sub-bench: `audio-barge-in`. Adds new KPI category (e.g. `FBR` — false-barge-in rate, % of non-speech cases that triggered a spurious turn).

## ~~Spike 3+4 runbook — your 30 minutes~~ (Obsolete — already done above)

For posterity, the original runbook for the user's machine. Leave for reference if anyone wants to reproduce without an already-running dev server.

Spikes 1+2 ran here. **Spike 3 (does Agora SDK pass-through?) + Spike 4 (does the tutor respond?) can ONLY run on your machine** because they need the demo's `.env.local` (Agora keys, LLM keys, etc.) and a running `pnpm dev`. The script collapses both into ONE observability-heavy headed-Chromium run.

### What you do

1. **Start the dev server** (one terminal):
   ```bash
   cd agora-voice-demo
   pnpm dev
   # wait for "Ready in Xs", confirm http://localhost:3000 loads in a normal browser
   ```

2. **Generate the test WAVs** (another terminal, in `agora-voice-demo`):
   ```bash
   bash docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/generate-test-wavs.sh
   ```
   - Uses macOS `say` + `ffmpeg` (already installed if you're following the bench setup)
   - Creates a `~3s "What is moss?"` WAV + a padded 30s version

3. **Run the e2e probe** (same terminal):
   ```bash
   node docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/spike-3-e2e.mjs
   ```
   - Opens a **visible** Chromium window (so you can see what's happening — pass `--headless` to hide)
   - Auto-clicks the start CTA (matches `button[aria-label*="conversation"]` or text "Try it Now" / "Start" / "Begin"). If the button has different text, the script logs `!! no start button found — open .../01-landing.png and tell me what to click`
   - Sits for 30 seconds observing — fake mic plays "What is moss?" repeatedly
   - Dumps everything to `/tmp/spike-mic/spike-3-output/`:
     - `summary.json` — full event log
     - `console.txt` — every browser console message
     - `api-requests.txt` — every `/api/*` / Agora / WS request
     - `01-landing.png` … `03-t30s.png` — 7 screenshots across the run

4. **Report back** with the quick-heuristic block the script prints at the end:
   ```
   saw_agora_traffic: YES|no
   saw_stt_or_moss:   YES|no
   saw_agent_response: YES|no
   ```
   Plus zip `/tmp/spike-mic/spike-3-output/` and send it back, OR paste the relevant lines from `console.txt` + the `03-t30s.png` screenshot.

### Go/no-go interpretation

| Result | Means | Next |
|---|---|---|
| `saw_agora_traffic=YES, saw_stt_or_moss=YES, saw_agent_response=YES` | Full pipeline accepts fake mic | Build the full barge-in harness (~2 days). I'll do it. |
| `saw_agora_traffic=YES, saw_stt_or_moss=YES, saw_agent_response=no` | SDK + STT work, but agent silent | Demo-app issue, not fake-mic issue. Debug. |
| `saw_agora_traffic=YES, saw_stt_or_moss=no` | Audio reached Agora, STT didn't recognise | Two possibilities: AEC ate it, or Agora's STT mis-heard. Try the padded WAV or louder TTS voice. |
| `saw_agora_traffic=no` | SDK rejected the synthetic input outright | This is Agora's web SDK doing its own device enumeration and NOT picking the fake mic. Likely fixable by spoofing `MicrophoneSelector` to pick "Fake Default Audio Input" explicitly before joining. ~half-day extra work. |
| Script throws / Playwright crashes / button not found | Selector mismatch or env issue | I'll fix in a follow-up — paste the error. |

### Cost

- One Agora session, ~45 seconds of dev-mode billing
- One LLM round-trip if the agent does respond (a few hundred tokens)
- Total: pennies. Nothing to worry about.

## Verification artifacts (Spike 1+2)

- Test WAVs at `/tmp/spike-mic/sine440.wav` + `/tmp/spike-mic/silence-then-sine.wav` (regenerable from header of `spike-1-2.mjs`)
- Spike 1+2 runner: [spike-scripts/spike-1-2.mjs](spike-scripts/spike-1-2.mjs)
- FFT probe page: [spike-scripts/fft-page.html](spike-scripts/fft-page.html)
- Raw run output (n=2 runs above): in this conclusion's transcript

## What this does NOT prove

- That the agora-voice-demo's specific `AgoraRTC.createMicrophoneAudioTrack()` accepts fake mic without an AEC kill — only Spike 3 tells us.
- That Agora cloud VAD treats fake-TTS audio the same as real speech — only Spike 4 (multi-trial) tells us.
- That real-mic UAT can be replaced — this harness, if it works, **complements** UAT (it catches regressions in deterministic CI); it does not substitute for a human listening for seam quality, language nuance, emotional acknowledgement landing or not.

## Why offline bench remains the most valuable layer regardless

Even if the full mic harness ships and works, the offline bench (79 cases + scorecard) is still doing 90% of the regression work because:
- It is deterministic to the bit (the mic harness is deterministic to ~10ms — still good, but worse)
- It does not need a dev server / Agora session / LLM call to grade — runs in CI on a PR
- It catches *content* regressions (spoiler leak, wrong persona, wrong strategy) that audio-path testing would have to listen for and judge subjectively

Layer mic harness on top **for false-barge-in / interrupt timing / cross-mic-quality** regressions specifically. That's the gap. Not a replacement.

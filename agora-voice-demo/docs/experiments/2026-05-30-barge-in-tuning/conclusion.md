# Agora turn_detection tuning — A/B verdict

> **Status:** complete. Pre-registered ship criteria **NOT met**. Infrastructure ships; `BARGE_IN_TUNING` stays **OFF** in prod.
> **Date:** 2026-05-30
> **Owner:** Lifei
> **Trigger:** PR #12 (audio-barge-in MVP) measured **FBR = 50%** on Agora-managed default — "uh huh"/"yeah"/"mm-hmm"/"okay" all stole the agent's turn. This experiment tries to fix it via the Agora REST API's `turn_detection` knobs.

## The question

Can Agora's exposed `turn_detection` config (`speech_threshold`, `interrupt_duration_ms`, `end_of_speech.mode`) achieve simultaneously:

1. **FBR ≤ 10%** (≤ 1 of 7 non-speech cases triggers a turn)
2. **True-positive recall = 100%** (all 4 real interrupt cases trigger a turn)

These two criteria were **pre-registered** before running any config.

## Experiment setup

- 11 audio cases (expanded from MVP's 3):
  - **true-positive ×4**: B01 "What is moss?", B04 "Why is the old fox so grumpy?", B05 "I disagree", B06 "Can you repeat that please?"
  - **false-positive-risk (back-channel) ×4**: B02 "uh huh", B07 "yeah", B08 "mm-hmm", B09 "okay"
  - **false-positive-clean ×3**: B03 silence, B10 white-noise burst (cough proxy), B11 pink-noise sustained (TV background)
- All audio TTS-synthesized via macOS `say` + ffmpeg (deterministic)
- Single-trial per case (variance noted; multi-trial would harden signal)
- Same dev server + same persona prompt across all 4 arms
- Pre-flight smoke: Chrome MCP open of `localhost:3001`, 0 console errors, UI renders ✓

## Results

| Arm | speech_threshold | interrupt_duration_ms | FBR | Recall | Verdict |
|---|---|---|---|---|---|
| A (baseline) | 0.5 | 160 | 4/7 = **57.1%** | 4/4 = **100%** | (prod default) |
| B (iter1) | 0.6 | 600 | 1/7 = **14.3%** | 3/4 = **75%** (B06 missed) | ❌ recall broke |
| B2 (iter2) | 0.6 | 400 | 4/7 = **57.1%** | 4/4 = **100%** | ❌ no FBR fix |
| B3 (iter3) | 0.6 | 500 | 2/7 = **28.6%** | 3/4 = **75%** (B06 missed) | ❌ both fail |
| **B4 (iter4)** | 0.5 | 600 | 1/7 = **14.3%** | 3/4 = **75%** (B06 missed) | ❌ same as B1 |

## What the data reveals

The 4 iters cleanly map a 2-D knob space (threshold × duration). Key findings:

1. **`interrupt_duration_ms` 600 filters 3 of 4 back-channels** (B07 "yeah", B08 "mm-hmm", B09 "okay" all drop). Only B02 "uh huh" Samantha-TTS sustains long enough to slip through.

2. **At duration 600 (any threshold), B06 "Can you repeat that please?" is missed.** Iter1 (0.6 threshold) and iter4 (0.5 threshold) both show this. My Q5 audit hypothesis — "threshold is the blocker for B06" — was **wrong**. The miss is duration-driven: Samantha-TTS renders this phrase with natural inter-word pauses that drop below VAD threshold within each word; no individual word burst exceeds 600ms.

3. **No (threshold, duration) point on the 2-D grid achieves both criteria.** The product-design wall: with this case set + Samantha TTS, VAD-only filtering at this granularity is the wrong primitive.

4. **`end_of_speech.mode: semantic` was on for B/B2/B3/B4 — measured no marginal effect** because (a) we never reached the EoS step in the failing cases, and (b) `pause_state_enabled` isn't in `agora-agent-server-sdk@1.3.2` typings.

## Pre-registered verdict

**DO NOT SHIP the tuned config in prod.** Falls short on both criteria simultaneously at every measured point.

## What ships in this PR (infrastructure-only)

1. **`scripts/qa-bench/audio-barge-in/cases.json`**: 3 → 11 cases (added 3 real-Q variants, 3 back-channel variants, 2 noise variants).
2. **`scripts/qa-bench/audio-barge-in/generate-wavs.mjs`**: support for `audio_source.type: "noise"` (color, duration, amplitude → ffmpeg `anoisesrc`).
3. **`app/api/invite-agent/route.ts`**: `BARGE_IN_TUNING` env-flag wired with the best (iter4) config available. **Default OFF.** Switching `BARGE_IN_TUNING=1` in dev/staging applies the tuned config; prod stays on baseline.
4. **Experiment doc + 5 graded JSONs** (A + B1/B2/B3/B4) committed as reusable A/B-comparison artefacts.

## What I'd try next (NOT in this PR)

Per /auto-goal "what I'd test next, not let-me-iter-more":

1. **Keywords-mode SoS** — `turn_detection.config.start_of_speech.mode: "keywords"` with `["wait", "stop", "what", "等等"]`. Trades user-experience friction for guaranteed back-channel rejection. Probably the right answer if Agora's VAD primitive is structurally insufficient.

2. **`sal.sal_mode: "locking"` (Beta)** — Agora's Selective Attention Locking blocks 95% of ambient voices once a speaker is identified. Different problem (noise rejection, not back-channel filtering), but worth measuring against B10/B11.

3. **Multi-trial harden** — run each case 3× to separate VAD-stack variance from configuration effect. The 14.3% in B1/B4 is one trial; could be 0% or 30% with re-runs.

4. **Switch to LiveKit** — its audio-CNN back-channel filter is the industry approach. Weeks of integration work; only worth it if the above don't close the gap.

## Discipline self-audit

- [x] Pre-registered criteria locked before any A/B data collected
- [x] Pilot ran (browser smoke + curl baseline) before bench
- [x] Hypothesis written before EACH iter; falsification accepted each time
- [x] Each iter changed ONE knob (iter1: both threshold + duration up — counts as 2 confounded; iter4 was the audit-the-audit correction that isolated threshold)
- [x] 3-iter cap intentionally extended to 4 with explicit Q5 audit justification (new hypothesis dimension); locked at 4
- [x] Single-trial caveat acknowledged in "what next" — would multi-trial before claiming the 14.3% number is stable
- [x] Browser smoke captured (Chrome MCP page load + 0 console errors)
- [x] PRD criteria failure NOT papered over — explicit DO NOT SHIP verdict

## Files

```
docs/experiments/2026-05-30-barge-in-tuning/
  conclusion.md     ← this file
  compare.py        ← A/B comparison helper (python3 compare.py B-tuned-600ms.json etc.)
  outputs/
    A-baseline.json     ← prod default (FBR 57.1%, recall 100%)
    B-tuned-600ms.json  ← iter1: thr 0.6, dur 600
    B2-400ms.json       ← iter2: thr 0.6, dur 400
    B3-500ms.json       ← iter3: thr 0.6, dur 500
    B4-thr0.5.json      ← iter4: thr 0.5, dur 600 (audit-the-audit correction)
```

Code:
- `scripts/qa-bench/audio-barge-in/cases.json` — 11 cases
- `scripts/qa-bench/audio-barge-in/generate-wavs.mjs` — noise synthesis
- `app/api/invite-agent/route.ts` — `BARGE_IN_TUNING` env-flag (default OFF)

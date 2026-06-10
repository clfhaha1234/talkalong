# Tutor / StepFun Voice Parity Notes

Last updated: 2026-06-05

This project now has two tutor-style realtime stacks:

- `/tutor`: Agora ConvoAI managed realtime session, with app-side branch/resume
  orchestration around narration.
- `/stepfun`: browser VAD + StepFun ASR/TTS + Gemini-lite QA brain, with local
  audio/state orchestration.

They should be benchmarked together because the user-visible failure classes are
the same even when the provider mechanics differ.

## Cross-Stack Benchmark

Run both stacks:

```bash
pnpm test:voice:cross
```

Run one stack:

```bash
STACKS=tutor pnpm test:voice:cross
STACKS=stepfun pnpm test:voice:cross
```

Run against Render:

```bash
TUTOR_URL=https://talkalong-tutor.onrender.com/tutor \
STEPFUN_URL=https://talkalong-tutor.onrender.com/stepfun \
pnpm test:voice:cross
```

This suite is intentionally opt-in. It uses real browser sessions, fake mic
audio, and live STT/TTS/LLM providers.

Current cases:

- `tutor:typed-sequential`: repeated same-session typed interrupts; catches
  stale branch ids, stale transcript refs, and bad resume timing.
- `tutor:voice-barge`: full fake-mic Agora round trip.
- `stepfun:stream`: StepFun streaming contract, first-audio timing,
  back-channel, and hold-turn behavior.
- `stepfun:followup-window`: QA answer must not be preempted by narration
  resume.
- `stepfun:multi-barge`: multiple same-session spoken interruptions.
- `stepfun:rapid-multi-barge`: the second spoken question lands while the first
  answer is still playing; exercises barge-in during `answering`/`thinking` and
  asserts narration resumes after back-to-back interrupts.

## What Tutor Should Teach StepFun

1. Branch generation guards.
   Tutor uses a monotonic branch generation id to drop stale timers/events after
   a newer interrupt opens. StepFun should keep the same principle for any future
   async ASR/TTS/rescript events that can arrive late.

2. Transcript attribution discipline.
   Tutor had real bugs where narration transcript text was misclassified as QA.
   StepFun has simpler local audio, but it still needs strict separation between
   narration text, user question, QA answer, and rescripted narration.

3. Rapid-repeat testing.
   Tutor's failures often appeared only on the second or third interrupt.
   StepFun now has `stepfun:multi-barge`, but it should eventually add a rapid
   variant where the second question lands before a full narration segment has
   resumed.

4. Language/rescript validation.
   Tutor's language-switch test catches subtitle/audio drift. StepFun recently
   hit the same class, so StepFun should gain an equivalent displayed-text and
   audio-source freshness check.

## What StepFun Should Teach Tutor

1. Local preemption is valuable.
   StepFun ducks local narration on the FIRST voiced frame and starts a
   tentative recording immediately, then commits the barge-in (full pause) only
   after sustained speech — so the response feels instant, blips never pause
   playback, and the head of the question is never clipped from the ASR clip.
   Barge-in is allowed in every phase, including `thinking` (aborts the pending
   QA turn, with a higher commit threshold) and `answering` (a false barge
   resumes the answer audio, not the narration). Resume rewinds ~1s and fades
   in. Tutor's local hush mirrors the same idea and should stay treated as a
   first-class requirement, not just a UI polish detail.

2. QA audio should be guarded as a resource.
   StepFun now prevents narration resume while QA audio is still playing. Tutor's
   branch/resume path should maintain the same invariant: mainline narration must
   never preempt an active answer.

3. Provider-stream contracts need their own tests.
   StepFun's `verify-stream` catches back-channel, hold-turn, and first-audio
   timing without opening a browser. Tutor would benefit from an analogous
   provider-level probe around branch-start / qa-ended contracts where feasible.

4. Rescript updates should be atomic.
   StepFun now treats narration text + TTS audio as one update. Tutor should keep
   the same mental model for any future narrator rewrite path: do not show new
   subtitles with old audio.

## Shared Invariants

These should become the benchmark vocabulary for both stacks:

- Barge-in latency: user speech/text must pause or hush main narration quickly.
- STT completeness: the question sent to QA must not be empty or partial.
- Answer attribution: an answer bubble must contain actual answer text, not a
  story narration substring.
- QA audio ownership: mainline narration must not resume while answer audio is
  playing.
- Follow-up window: after an answer, there must be a short listening window
  before resume.
- Repeatability: the second and third interrupts in a session must work.
- Rescript atomicity: displayed narration and spoken narration must match after
  language/style changes.
- False-barge control: acknowledgements, echo, coughs, and background audio
  should not create real QA branches.

## Recommended Next Benchmark Additions

1. `stepfun:lang-switch`.
   Mirror tutor's language-switch e2e: ask to continue in Chinese, assert the
   next displayed narration is Chinese and old English audio is not reused.

2. `tutor:followup-window`.
   Tutor has resume seam checks, but a DOM-level no-mainline-resume guard would
   make it comparable to StepFun's current test.

3. Unified JSON output.
   The cross runner currently prints each child script's native output. Add
   optional `VOICE_BENCH_JSON=/path/result.json` once the metrics stabilize.


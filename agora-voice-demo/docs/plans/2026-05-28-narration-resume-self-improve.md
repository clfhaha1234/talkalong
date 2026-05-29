# Narration + Text-Interrupt Resume — Self-Improve Plan

- **Modality**: debug / mixed (live SSE harness against dev server, no headless WebRTC)
- **Pass gate**:
  - G1 — Golden path: all scenes' `segment_started`/`segment_completed` fire in order, spaced by real audio duration (consecutive `segment_started` gaps ≈ `approx_duration_ms`, NOT all <150ms apart). Reaches `narration_complete`.
  - G2 — Text interrupt: a `/api/tutor/qa-ended` POST mid-narration produces `bridge_started` → `active_scene_changed` → `branch_ended` → `bridge_completed`.
  - G3 — Resume: after the interrupt the narrator resumes (a fresh `segment_started` from the planner's chosen pointer) and the run still reaches `narration_complete` with no hang and no double session.stop().
  - G4 — Planner sanity: server log shows a `resume plan: strategy=… source=…` line with a valid strategy.
- **Max iterations**: 6
- **Why this harness**: headless Chromium + Agora WebRTC tears the page down; and the changed logic (narrator pointer loop, resume-planner, ProgressState waits) is all server-side. Hitting the live route via HTTP exercises the real orchestrator + real Gemini + real Agora session, which is exactly prod minus audible audio.

## Reset procedure
Each iteration starts a brand-new lesson session (new channel, new session_id). No shared state between runs other than the on-disk script/image caches (which are content-addressed and safe to reuse). Reset = just run the harness fresh. <5s.

## Iteration log

### Iteration 1 / 6 — text-interrupt mid-narration (INTERRUPT=on, after seg #2)
- Reset: ✅ fresh lesson session `lesson-1780001853947-vsv8`
- Topic: "Why the sky is blue — Rayleigh scattering for a 9-year-old"
- Timeline: s1 (16.7s) → s2 interrupted mid-play (2.7s in) → bridge → resumed s2 (19s) → s3 (15.6s) → s4 (17.1s) → s5 (15.6s) → narration_complete @ 141s
- **All gates PASS.** gaps(ms)=[16684, 2769, 19035, 15619, 17126] — every full scene >15s real audio spacing (per-segment sleep working); the 2.7s gap is the interrupt→resume transition.
- Planner: strategy=`continue`, bridge="Just like those marbles bouncing off one another, the light…" — **tied the Q&A answer (marbles) back into the story in character.** active_scene_changed scene=s2 (stayed on paused page). This is the teacher-like resume the user asked for.
- New issues: 1 (word-reveal speed polish). Then found Issue 2 (planner blind to interrupt timing) by code review.
- Status: PASS — hunting edge cases in iter 2.

### Iteration 2 / 6 — golden path, NO interrupt (不打断直接播放)
- Reset: ✅ fresh session `lesson-1780001994496-nnfs`, caches warm (script + 5 images instant)
- Pure sequential playback: s1→s5, each ~16-17s real audio, narration_complete @ 85s. **ALL CHECKS PASS.**
- Confirms the no-interrupt path has no regression from the pointer-loop rewrite. Cache makes start near-instant (1.6s vs 52s cold).

### Iteration 3 / 6 — EARLY interrupt on seg #1 (validates Issue 2 fix)
- Reset: ✅ fresh session `lesson-1780002113935-i22f`
- Fix applied first: ProgressState.currentSegmentProgress() + handleQaEnded captures real % spoken (was hardcoded 0.5).
- Interrupt fired ~1.2s into s1 (≈7% spoken). Planner picked **restart** (reason=planner_restart, scene=s1) — re-told s1 (21s, folding in the Q&A) then continued s2→s5.
- **Contrast with iter 1** (mid-scene interrupt → continue): same code, different strategy purely from the real timing signal. Confirms Issue 2 fix changes behavior correctly.
- Issue 1 (word-reveal pace) also fixed in this iteration: reveal now spread across estimated scene audio duration (17 cps) instead of fixed 4.2 WPS.
- Unit tests: 77 passing.

### Iteration 4 / 6 — LAST-scene interrupt (empty next_scenes edge case)
- Reset: ✅ fresh session `lesson-1780002230154-mwid`
- Interrupt 0.6s into s5 (the final scene; next_scenes=[]). Planner correctly picked **restart** (not a skip into the void), re-told s5, narration_complete @ 92s. **ALL CHECKS PASS.**
- Confirms the degenerate empty-next_scenes path is handled by the LLM + validation without crashing.

### Iteration 5 / 6 — MULTI-interrupt (2 BRANCH cycles in one session)
- Reset: ✅ fresh session `lesson-1780002384615-hk5i`
- Interrupt on s2 → restart → re-spoke s2; then interrupt on s3 → restart → re-spoke s3; then s4, s5 → narration_complete @ 94s.
- gaps(ms)=[16814, 2652, 18461, 2463, 17935, 17346] — two short transition gaps (the resumes) bracketed by full-scene audio. **ALL CHECKS PASS** including G4 (2 bridges for 2 interrupts).
- **Confirms the pointer-driven narrator + ProgressState survive repeated BRANCH entry/exit with no state corruption** — the one path unit tests couldn't fully cover.

## Verdict
Pass gate GREEN across 5 live iterations spanning the full interrupt spectrum:
no-interrupt, first-scene, mid-scene, last-scene, and back-to-back multi-interrupt.
2 issues found and fixed (interrupt-timing signal; audio-paced reveal). No bugs
remaining. Voice interrupt itself can't be driven headless, but its server-side
resume path is identical to the text path proven here. Clean completion at iter 5
of 6.

## Issues found

#### Issue 1: word reveal speed decoupled from audio pace
- **Type**: UI Polish
- **Modality**: browser
- **Severity**: Minor
- **What**: StoryScreen reveals narration text at a fixed 4.2 WPS (~25 chars/sec); audio plays at the orchestrator's ~17 chars/sec heuristic. Text finishes revealing several seconds before the page turns (segment_completed), leaving fully-revealed text sitting idle.
- **Expected**: reveal pace tracks the segment's approx_duration_ms so the last word lands ~when the audio ends.
- **Root cause**: WPS is a hardcoded constant in StoryScreen, never derived from the active scene's duration.
- **Fix**: reveal interval = estimateSceneAudioMs(text) / totalTokens (17 cps + 150ms tail), floored at 40ms.
- **Status**: FIXED (iter 3)

#### Issue 2: paused_scene_progress hardcoded to 0.5 — planner blind to interrupt timing
- **Type**: Bug (quality)
- **Modality**: debug
- **Severity**: Important
- **What**: handleQaEnded in lib/orchestrator/index.ts passes `paused_scene_progress = 0.5` literally. The resume planner's restart-vs-skip bias is supposed to key off "how much of the scene was heard," but it always sees 50%. A user who interrupts in the first 2 seconds of a scene and one who interrupts at the very end get the same timing signal.
- **Expected**: compute real % spoken = (branch_start_wallclock − segment_start_wallclock) / approx_duration_ms, clamped 0..1.
- **Root cause**: ProgressState never records the wall-clock time a segment started, so handleQaEnded can't compute elapsed playback.
- **Fix**: record `current_segment_started_at` in startSegment; expose it; compute pct in handleQaEnded.
- **Status**: FIXED (iter 3) — verified end-to-end: early interrupt now yields restart vs mid-scene continue.


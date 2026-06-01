// Pure logic extracted from run-latency.mjs so vitest can import it without
// triggering the script's top-level main() that launches Playwright. The README
// claimed these were unit-tested; they weren't until run-latency-lib.test.ts
// landed alongside this file.
//
// Everything here is pure: no side effects, no I/O, no network.

// ── Known FIXED timings baked into the app (not measured — read from source).
// Surfaced in the report so the end-to-end budget separates "tunable product
// decision" from "live LLM/network latency". If you change the source, the
// drift-guard test in run-latency-lib.test.ts fails — keep it in sync.
export const KNOWN_FIXED = {
  // components/TutorPage.tsx `SILENCE_TIMEOUT_MS` — the AFTER-ANSWER silence
  // window before we treat the Q&A as over and resume. Pure UX knob: lower =
  // snappier resume but risks cutting a mid-thought pause; higher = sluggish.
  // Dynamic as of 2026-06-01 (a no-answer/false barge uses a shorter
  // SILENCE_NO_ANSWER_MS); this mirrors the after-answer value, the dominant
  // component of "how long after I stop talking does the story continue".
  silence_confirm_ms: 1400,
};

// ── UX target bands (ms). What a listener perceives, from voice-UX norms:
// <1s instant, 1-2s natural, 2-4s noticeable, >4s sluggish. Used to colour the
// report so a number means "good/ok/slow", not just a raw figure.
export const BANDS = {
  t1_pause: { good: 600, ok: 1200 },   // it should stop talking fast
  t2_reply: { good: 1500, ok: 3000 },  // answer onset
  t3_resume: { good: 3500, ok: 5500 }, // includes the 2s silence-confirm wait
  total: { good: 5000, ok: 8000 },     // whole round trip
};

/** Colour band for a single ms reading. Null → '—'. */
export function band(ms, b) {
  if (ms == null) return '—';
  if (ms <= b.good) return '🟢';
  if (ms <= b.ok) return '🟡';
  return '🔴';
}

/**
 * Derive the three barge-in latencies from a timestamped DOM-snapshot
 * timeline + the interrupt onset (configured via the WAV's lead silence;
 * fake-mic spike validated ±6ms determinism).
 *
 *   T1  interrupt onset → first branch state (story paused to listen)
 *   T2  branch state → answer text appears
 *   T3  answer → branch clears (back to now-reading)
 *
 * Returns null for any latency where the upstream event never occurred —
 * e.g. T2/T3 are null if T1 never fired.
 */
export function deriveLatencies(timeline, leadMs) {
  const interruptT = leadMs;
  const firstBranch = timeline.find((s) => s.t >= interruptT && s.inBranch);
  const t1 = firstBranch ? firstBranch.t - interruptT : null;

  let t2 = null;
  let t3 = null;
  if (firstBranch) {
    const firstAnswer = timeline.find(
      (s) => s.t >= firstBranch.t && s.answerText && s.answerText.length > 1,
    );
    t2 = firstAnswer ? firstAnswer.t - firstBranch.t : null;
    // Resume = branch clears (back to now-reading) after the answer.
    const base = firstAnswer ?? firstBranch;
    const resume = timeline.find((s) => s.t >= base.t && !s.inBranch && s.nowReading);
    t3 = resume ? resume.t - base.t : null;
  }
  return { interrupt_ms: interruptT, t1_pause_ms: t1, t2_reply_ms: t2, t3_resume_ms: t3 };
}

/** Nearest-rank percentile. Filters nulls. Empty → null. */
export function pct(arr, p) {
  const xs = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
  return xs[i];
}

/**
 * Split T3 (resume) into the fixed tunable wait vs the variable live work.
 *   live = max(0, t3 - fixed)
 * The clamp matters: t3 can be < fixed when the listener pauses for less time
 * than the silence-confirm window (e.g. a rapid back-and-forth), in which case
 * the negative live-work share is meaningless noise.
 */
export function resumeBudget(t3_ms, fixed_ms) {
  if (t3_ms == null) return { fixed_ms, live_ms: null };
  return { fixed_ms, live_ms: Math.max(0, t3_ms - fixed_ms) };
}

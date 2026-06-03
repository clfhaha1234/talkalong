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
  // Raised 1400→4000 (2026-06-01): a storyteller pauses after answering so the
  // listener can ask a follow-up; 1.4s resumed too fast ("回主线太快").
  silence_confirm_ms: 4000,
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

/**
 * Derive the same barge-in metrics from TutorPage's seam stream:
 *   { t, ev, detail } where ev is mic_live/state/user_txt/branch_post/qa_post/segment.
 *
 * This is intentionally stricter than the old latency-only view. A UI can show
 * a user bubble and even produce an answer while the server-side narrator stays
 * in MAIN; that was the typed-QA regression from 2026-06-01. `branch_posted`
 * is therefore a first-class correctness signal, not just debug decoration.
 */
export function deriveSeamLatencies(seams, leadMs) {
  const micLive = seams.find((s) => s.ev === 'mic_live');
  if (!micLive) return { error: 'no mic_live seam (mic never went live)' };
  const onset = micLive.t + leadMs;

  const listen = seams.find(
    (s) => s.ev === 'state' && s.detail === 'listening' && s.t >= onset - 500,
  );
  const t1 = listen ? Math.max(0, listen.t - onset) : null;

  let t2 = null;
  let t3 = null;
  let answerEnd = null;
  let resume = null;
  let speak = null;
  let userTxt = null;
  let branchPost = null;
  let qaPost = null;

  if (listen) {
    userTxt = seams.find((s) => s.ev === 'user_txt' && s.t >= listen.t - 1500)?.detail ?? null;
    branchPost = seams.find((s) => s.ev === 'branch_post' && s.t >= listen.t - 500) ?? null;
    qaPost = seams.find((s) => s.ev === 'qa_post' && s.t >= listen.t) ?? null;

    // T2/T3 (answer + resume) are ONLY meaningful when the question actually
    // transcribed — otherwise a following `speaking` seam may be narration.
    if (userTxt) {
      speak = seams.find((s, i) => {
        if (s.ev !== 'state' || s.detail !== 'speaking' || s.t < listen.t) return false;
        const prevSeg = [...seams.slice(0, i)].reverse().find(
          (p) => p.ev === 'segment' || (p.ev === 'state' && p.detail === 'speaking'),
        );
        return !(prevSeg && prevSeg.ev === 'segment' && s.t - prevSeg.t < 1500);
      });
      t2 = speak ? speak.t - listen.t : null;
      if (speak) {
        answerEnd = seams.find((s) => s.ev === 'state' && s.detail !== 'speaking' && s.t > speak.t);
        const base = answerEnd ?? speak;
        resume = seams.find((s) => s.ev === 'segment' && s.t >= base.t);
        t3 = resume ? resume.t - base.t : null;
      }
    }
  }

  const listens = seams.filter((s) => s.ev === 'state' && s.detail === 'listening');
  const falseBarges = listens.filter(
    (l) => !seams.some((s) => s.ev === 'user_txt' && s.t >= l.t - 500 && s.t <= l.t + 3000),
  ).length;

  return {
    onset_ms: onset,
    t1_pause_ms: t1,
    t2_reply_ms: t2,
    t3_resume_ms: t3,
    stt_text: userTxt,
    stt_ok: !!userTxt,
    branch_posted: !!branchPost,
    branch_post_ms: branchPost && listen ? branchPost.t - listen.t : null,
    qa_posted: !!qaPost,
    listen_count: listens.length,
    false_barge_count: falseBarges,
  };
}

/**
 * Fast verdict for the typed-QA path. This catches the manual Render failure
 * mode where the user bubble appears, but the narrator keeps talking because
 * the typed path never performed the local hush / branch transition.
 *
 * Input is the same seam array used by the heavier live harness:
 *   typed_txt <text>       user submitted a typed question
 *   hush 0                client locally muted the remote agent audio
 *   branch_post N:typed   browser told the orchestrator to enter BRANCH
 *   state speaking        answer started (optional; may exceed a short smoke)
 */
export function deriveTypedQaVerdict(seams, opts = {}) {
  const maxHushMs = opts.maxHushMs ?? 250;
  const maxBranchMs = opts.maxBranchMs ?? 500;
  const maxAnswerMs = opts.maxAnswerMs ?? 8000;

  const typed = seams.find((s) => s.ev === 'typed_txt');
  if (!typed) {
    return {
      ok: false,
      typed_seen: false,
      hush_ok: false,
      branch_ok: false,
      answer_started: false,
      failures: ['missing typed_txt seam'],
    };
  }

  const hush = seams.find((s) => s.ev === 'hush' && String(s.detail) === '0' && s.t >= typed.t);
  const branch = seams.find(
    (s) => s.ev === 'branch_post' && /:typed\b/.test(String(s.detail ?? '')) && s.t >= typed.t,
  );
  const answer = seams.find((s) => s.ev === 'state' && s.detail === 'speaking' && s.t >= typed.t);

  const hushMs = hush ? hush.t - typed.t : null;
  const branchMs = branch ? branch.t - typed.t : null;
  const answerMs = answer ? answer.t - typed.t : null;
  const failures = [];

  if (hushMs == null) failures.push('typed question did not locally hush agent audio');
  else if (hushMs > maxHushMs) failures.push(`typed hush too slow (${hushMs}ms > ${maxHushMs}ms)`);

  if (branchMs == null) failures.push('typed question did not POST branch-started as typed');
  else if (branchMs > maxBranchMs) failures.push(`typed branch_post too slow (${branchMs}ms > ${maxBranchMs}ms)`);

  if (answerMs != null && answerMs > maxAnswerMs) {
    failures.push(`typed answer started too slowly (${answerMs}ms > ${maxAnswerMs}ms)`);
  }

  return {
    ok: failures.length === 0,
    typed_seen: true,
    hush_ok: hushMs != null && hushMs <= maxHushMs,
    branch_ok: branchMs != null && branchMs <= maxBranchMs,
    answer_started: answerMs != null,
    typed_text: typed.detail ?? '',
    hush_ms: hushMs,
    branch_ms: branchMs,
    answer_ms: answerMs,
    failures,
  };
}

export const ANSWER_TEASE_RE =
  /haven'?t (learned|met|been told)|not learned|secret the story|keep listening|hasn'?t been (revealed|told)|just yet|find out|about to meet/i;

export const ANSWER_FALLBACK_RE = /trouble answering right now/i;

export const ANSWER_NARRATION_LEAK_RE = /padded softly|grassy hill|sat on a grassy hill|when the moon rises/i;

/**
 * Content-level QA verdict for the answer bubble. This is intentionally small
 * and deterministic: the full live suite can use an LLM judge, but the daily
 * smoke should catch the user-visible failures without another model call.
 */
export function evaluateQaAnswer(answer, opts = {}) {
  const text = String(answer ?? '').trim();
  const lower = text.toLowerCase();
  const expected = String(opts.expected ?? '').trim().toLowerCase();
  const kind = opts.kind ?? (expected ? 'factual' : 'any');
  const rejectTease = opts.rejectTease ?? kind !== 'any';
  const minChars = opts.minChars ?? 2;
  const narrationLeakRe = opts.narrationLeakRe ?? ANSWER_NARRATION_LEAK_RE;
  const failures = [];

  if (text.length < minChars) failures.push('missing answer text');
  if (ANSWER_FALLBACK_RE.test(text)) failures.push('answer is the error fallback');
  if (narrationLeakRe.test(text) && (!expected || !lower.includes(expected))) {
    failures.push('answer bubble looks like leaked narration');
  }
  if (expected && !lower.includes(expected)) {
    failures.push(`answer did not contain expected token "${expected}"`);
  }
  if (rejectTease && ANSWER_TEASE_RE.test(text)) {
    failures.push('answer teased/deflected when this case requires a direct response');
  }
  if (kind === 'opener') {
    const welcomed =
      /\b(yes|yeah|hello|hi|hear you|can hear|go ahead|ask|what would you like|how can i help)\b/i.test(text);
    if (!welcomed) failures.push('opener/greeting was not warmly acknowledged');
  }

  return {
    ok: failures.length === 0,
    text,
    expected,
    kind,
    teased: ANSWER_TEASE_RE.test(text),
    fallback: ANSWER_FALLBACK_RE.test(text),
    failures,
  };
}

/**
 * Seam-level resume contract: after the branch produces an agent reply, the
 * client must not POST /qa-ended immediately. This catches the manual failure
 * where the answer started, then the main story resumed over its tail because a
 * stale no-answer timer fired before the transcript path re-armed the longer
 * after-answer window.
 */
export function deriveQaResumeVerdict(seams, opts = {}) {
  const minAfterReplyMs = opts.minAfterReplyMs ?? 2500;
  const maxAfterReplyMs = opts.maxAfterReplyMs ?? 9000;
  const branchStart =
    seams.find((s) => s.ev === 'typed_txt' || s.ev === 'user_txt' || s.ev === 'branch_post') ?? null;
  const failures = [];

  if (!branchStart) {
    return {
      ok: false,
      agent_reply_seen: false,
      qa_post_seen: false,
      qa_post_after_reply_ms: null,
      failures: ['missing branch start seam'],
    };
  }

  const agentReply = seams.find((s) => s.ev === 'agent_reply' && s.t >= branchStart.t) ?? null;
  const qaPost = seams.find((s) => s.ev === 'qa_post' && s.t >= branchStart.t) ?? null;
  const segment = seams.find((s) => s.ev === 'segment' && s.t >= branchStart.t) ?? null;

  if (!agentReply) failures.push('missing agent_reply seam before resume');
  if (!qaPost) failures.push('missing qa_post seam');
  if (agentReply && qaPost) {
    const delta = qaPost.t - agentReply.t;
    if (delta < 0) failures.push(`qa_post happened before agent_reply (${delta}ms)`);
    else if (delta < minAfterReplyMs) {
      failures.push(`qa_post too soon after agent_reply (${delta}ms < ${minAfterReplyMs}ms)`);
    } else if (delta > maxAfterReplyMs) {
      failures.push(`qa_post too slow after agent_reply (${delta}ms > ${maxAfterReplyMs}ms)`);
    }
  }
  if (agentReply && segment && segment.t < agentReply.t) {
    failures.push('main narration segment resumed before agent reply');
  }

  return {
    ok: failures.length === 0,
    agent_reply_seen: Boolean(agentReply),
    qa_post_seen: Boolean(qaPost),
    qa_post_after_reply_ms: agentReply && qaPost ? qaPost.t - agentReply.t : null,
    failures,
  };
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

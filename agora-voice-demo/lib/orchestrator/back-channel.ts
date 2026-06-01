// Back-channel detection for the Q&A resume path.
//
// A "back-channel" is a listener acknowledgement that ISN'T a question —
// "okay", "yeah", "uh huh", "mm", "right", "got it". When a barge-in transcribes
// to ONLY back-channel tokens, the resume planner should NOT run and NO bridge
// should be spoken: the agent would otherwise interrupt its own story with a
// chatty "Good question — now where were we?" over an utterance that asked
// nothing. Instead we resume the narration silently (same treatment as the
// no-question guard).
//
// Deliberately TIGHT: question words ("why", "what", "how", "who", "where",
// "when") are NOT back-channels, and "no" is excluded (it can begin a
// correction — "no, I meant the OTHER one"). Better to occasionally run the
// planner on a borderline utterance than to swallow a real question.

const BACK_CHANNELS = new Set([
  'ok', 'okay', 'kay', 'k',
  'yeah', 'yep', 'yes', 'yup', 'ya',
  'uh huh', 'uhhuh', 'mhm', 'mm', 'mmhmm', 'mmm', 'hmm', 'hm',
  'right', 'sure', 'cool', 'nice', 'wow', 'ah', 'oh', 'aha', 'huh',
  'got it', 'gotcha', 'i see', 'ic', 'ok cool', 'okay cool', 'alright', 'all right',
]);

const MAX_BACK_CHANNEL_LEN = 14; // chars of normalised text; longer = a real utterance

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, '') // drop punctuation/digits
    .replace(/\s+/g, ' ')
    .trim();
}

function isBackChannelText(text: string): boolean {
  const norm = normalise(text);
  if (!norm || norm.length > MAX_BACK_CHANNEL_LEN) return false;
  // Whole-phrase match ("uh huh", "got it") OR every token is an acknowledger
  // ("okay yeah").
  if (BACK_CHANNELS.has(norm)) return true;
  return norm.split(' ').every((w) => BACK_CHANNELS.has(w));
}

/**
 * True when the listener's side of the Q&A is non-empty but consists ONLY of
 * back-channel acknowledgements (no actual question). Returns false for empty
 * histories — that's the separate no-question guard's job.
 */
export function isBackChannelOnly(
  qa_history: Array<{ role: 'user' | 'agent'; text: string }>,
): boolean {
  const userTurns = qa_history.filter((t) => t.role === 'user' && t.text.trim().length > 0);
  if (userTurns.length === 0) return false;
  return userTurns.every((t) => isBackChannelText(t.text));
}

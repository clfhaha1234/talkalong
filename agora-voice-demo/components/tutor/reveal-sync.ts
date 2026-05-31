// Audio-synced word reveal — the fix for "字幕和语音对不上" (the on-screen words
// not matching the spoken audio).
//
// The old reveal advanced word-by-word on a fixed CHARS_PER_SEC timer with no
// connection to the actual audio, so the cursor raced ahead of (or lagged) the
// voice — especially after the voice changed and its real rate stopped matching
// the constant. Agora's client toolkit actually streams the agent's spoken
// transcript word-by-word with playback timing, so the honest fix is to reveal
// exactly the words Agora reports as spoken.
//
// This module is the PURE matcher: given the scene's narration and the live
// agent transcript, how many of StoryScreen's reveal tokens should be visible.
// Kept pure + unit-tested so the alignment logic can't silently regress.

import { tokenize } from './theme';

/** Lowercase + strip leading/trailing punctuation so "light," == "Light". */
function normWord(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * How many `tokenize(narration)` tokens StoryScreen should reveal, given the
 * agent has actually spoken `spokenSoFar` (Agora's live agent-transcript text
 * for the current turn).
 *
 * Words are aligned from the start of the scene. The return value is in
 * StoryScreen's token space — `tokenize` splits on whitespace KEEPING the
 * separators, so each word occupies two tokens (word + trailing space) and a
 * matched word-count of `k` maps to `2k` tokens.
 *
 * Returns -1 when `spokenSoFar` does NOT align with the start of `narration`
 * (e.g. the transcript is still showing the previous scene, a resume bridge, or
 * a Q&A answer). The caller treats -1 as "no reliable signal — fall back to the
 * bootstrap timer" rather than snapping the cursor to a wrong place.
 */
export function revealedTokenCount(narration: string, spokenSoFar: string): number {
  const nWords = wordsOf(narration);
  const sWords = wordsOf(spokenSoFar);
  if (nWords.length === 0 || sWords.length === 0) return 0;

  let matched = 0;
  while (
    matched < nWords.length &&
    matched < sWords.length &&
    normWord(nWords[matched]) === normWord(sWords[matched])
  ) {
    matched++;
  }

  if (matched === 0) return -1; // no alignment — different scene/bridge/QA
  // A single coincidental word match (e.g. both start with "The") isn't enough
  // to trust when the speaker is clearly several words in.
  if (sWords.length >= 3 && matched <= 1) return -1;

  const tokenLen = tokenize(narration).length;
  return Math.min(tokenLen, matched * 2);
}

/**
 * Which scene the agent is CURRENTLY narrating, inferred from the live agent
 * transcript. Returns the index of the scene whose narration `spokenSoFar`
 * aligns to best (longest matched word-prefix), or -1 when nothing aligns
 * (silence, a bridge, or a Q&A answer). Used to drive the reading view's
 * "current page" + image off the real audio instead of the server's timer, so
 * the page can't flip ahead of the voice.
 */
export function matchSceneIndex(narrations: string[], spokenSoFar: string): number {
  if (!spokenSoFar || spokenSoFar.trim().length === 0) return -1;
  let bestIdx = -1;
  let bestTokens = 0;
  for (let i = 0; i < narrations.length; i++) {
    const n = revealedTokenCount(narrations[i], spokenSoFar);
    if (n > bestTokens) {
      bestTokens = n;
      bestIdx = i;
    }
  }
  return bestIdx;
}

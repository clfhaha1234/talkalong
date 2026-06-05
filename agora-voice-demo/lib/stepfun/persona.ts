// Shared storyteller persona for the StepFun tutor's Q&A (typed + spoken).
// Ports the "excellent teacher" rules hard-won on the Agora side
// (docs/postmortem-2026-06-01-qa-no-answer.md + the persona iterations):
//   - answer in ONE warm sentence, in character; then stop (no bridging — the
//     story resumes on its own).
//   - a FACT already in the story is never a spoiler — answer it directly.
//   - a fact NOT yet introduced: NEVER invent it (a wrong name is the worst
//     outcome) — build anticipation ("you're about to meet them!").
//   - a future PLOT EVENT/ENDING stays a gentle secret.
//   - an off-topic question (a bare sum, far-off trivia) → a warm deflection.

export const STEPFUN_QA_SYSTEM = `You are the warm, gentle voice of a storybook narrator reading to a child (ages 8-12). The listener has interrupted to ask a question. Answer EXACTLY by these rules:

1. ONE sentence, at most 20 words, in character as the storyteller. Then STOP — do not narrate on, do not bridge back, do not summarize; the story resumes on its own.
2. A FACT the story has ALREADY told you (a name, who someone is, where we are, what it's about) is never a spoiler — answer it warmly and directly from the story so far.
3. A fact that simply hasn't been introduced YET (you do NOT know it from the story so far): NEVER invent it — guessing a name or detail and being wrong is the worst thing you can do. Build warm anticipation instead: "Oh, you're just about to meet them — keep listening!".
4. A future PLOT EVENT or OUTCOME (what a character will do next, how a conflict turns out, how it ENDS) stays a gentle secret: "that's a secret the story is keeping a little longer — listen on.".
5. A question with NOTHING to do with the story (a bare sum like "what is 12 times 7", an unrelated far-off capital) — gently call it a puzzle for another time and turn back, one sentence.
6. Never begin with "okay", "sure", "great question", or any comment about yourself. No lists. Plain warm spoken prose.`;

/** Build the user message that grounds the answer on what's been narrated. */
export function stepfunQaUserMessage(question: string, storySoFar: string): string {
  return `The story so far (everything the listener has heard — do NOT use anything beyond this):\n"${storySoFar.slice(0, 2000)}"\n\nThe child asks: ${question.trim()}`;
}

function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Echo / false-barge guard. When narration plays through speakers, the mic can
 * catch it; the ASR transcript is then a CHUNK OF THE STORY, not a question. A
 * real question almost never reproduces a contiguous stretch of the narration.
 * If the transcript is (mostly) contained in what's been narrated, treat it as a
 * false barge-in and resume — don't "answer" the story back to the listener.
 * (Server-side backstop to client-side AEC; not a question-vs-statement judge.)
 */
export function looksLikeNarrationEcho(transcript: string, storySoFar: string): boolean {
  const t = normalizeForEcho(transcript);
  const story = normalizeForEcho(storySoFar);
  if (t.length < 12 || story.length < 12) return false;
  if (story.includes(t)) return true; // verbatim echo
  // partial/noisy echo: how many of the transcript's words appear in the story?
  const words = t.split(' ').filter(Boolean);
  if (words.length < 4) return false;
  const storyWords = new Set(story.split(' '));
  const overlap = words.filter((w) => storyWords.has(w)).length / words.length;
  return overlap >= 0.85;
}

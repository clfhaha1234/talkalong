// lib/orchestrator/bridge-library.ts
//
// Fallback bridge lines used when the LLM bridge call exceeds the budget
// or fails. Phrased to be content-agnostic so they fit any paused segment.

export const BRIDGES: string[] = [
  "Right, so to bring it back to where we were — let me pick up from the last point.",
  "Okay, that's a good one to set down for now. Coming back to the main thread.",
  "Got it. So back to what we were talking about — let me keep going.",
  "Alright. Picking up where we left off — here's what came next.",
  "Sure thing. Back to the through-line — the next part is where it gets interesting.",
  "Fair enough. So, coming back to our story — let me keep reading.",
  "Hmm, makes sense. Now back to where we were, here's the next bit.",
  "Got that. Returning to the main thread — let me pick it up from there.",
  "Right. So back to where we paused, the next thing to know is —",
  "Okay. Coming back around — let me carry on from where we left off.",
  "Mmhmm. So, back to the main story — let me keep going from there.",
  "Sure. Let me bring us back to where we were, just before that question.",
];

export function pickBridge(): string {
  return BRIDGES[Math.floor(Math.random() * BRIDGES.length)];
}

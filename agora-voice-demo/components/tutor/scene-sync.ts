// Keep the DISPLAYED subtitle in lockstep with the SPOKEN narration.
//
// The bug this fixes (found live 2026-05-31): when the listener asks the tutor
// to switch language ("can you speak in Chinese?"), the resume-planner rewrites
// the upcoming segments' TEXT to Chinese and the agent SPEAKS Chinese — but the
// StoryScreen kept rendering the original English `scene.narration_text`, so the
// audio was Chinese while the subtitle stayed English.
//
// Root cause: the rewrite lands in ProgressState.segments (the spoken source).
// The only event that carries the new text to the UI is `segment_started.text`
// — and TutorPage's handler used it only to pick the scene INDEX, discarding
// the text. The orchestrator emits one segment per scene (segment_id ===
// scene.id, text === narration_text), so syncing the matched scene's
// narration_text to the event's text makes subtitle == audio BY CONSTRUCTION,
// for the language switch and any future segment rewrite.
//
// Pure + unit-tested so the contract can't silently regress.

import type { Scene } from './theme';

/**
 * Return `scenes` with the narration_text of the scene whose id === segmentId
 * replaced by `text`. No-op (returns the SAME array reference) when there's no
 * matching scene, the text is empty/whitespace, or it already matches — so a
 * normal English run never churns React state.
 */
export function applyNarrationText(
  scenes: Scene[],
  segmentId: string,
  text: string | undefined | null,
): Scene[] {
  const next = (text ?? '').trim();
  if (!next) return scenes;
  const idx = scenes.findIndex((s) => s.id === segmentId);
  if (idx < 0) return scenes;
  if (scenes[idx].narration_text === next) return scenes;
  const out = scenes.slice();
  out[idx] = { ...out[idx], narration_text: next };
  return out;
}

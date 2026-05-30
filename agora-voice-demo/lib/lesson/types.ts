// Phase A lesson types — small, intentionally additive to the existing
// orchestrator types so the UI can consume both side-by-side.

import type { DetectedLanguage } from '@/lib/language-config';

export interface Scene {
  /** Stable id within a session; sequential s1, s2, ... */
  id: string;
  /** Title-bar text like "Chapter One". */
  chapter: string;
  /** Sub-title like "Scene I" / "Scene II". */
  sceneNum: string;
  /**
   * 2-line headline for the spread, displayed in italic serif at the top of
   * the right-hand page. e.g. ["A curious question", "about time."]
   * Always exactly 2 strings — pad with '' if needed.
   */
  headline: [string, string];
  /** The narration text the agent will speak for this scene. */
  narration_text: string;
  /**
   * The scene description that gets stuffed into the storybook image prompt
   * as the `Scene:` placeholder. Should be a single declarative sentence
   * describing what the illustration shows. ~80-160 chars.
   */
  image_prompt: string;
  /**
   * Filled in by the SSE pipeline after image generation completes.
   * Until then, undefined.
   */
  image_url?: string;
  /**
   * Filled in by the SSE pipeline after the still illustration is animated
   * into a clip (parent Remotion project). Until then, undefined and the UI
   * shows the static image_url. Scene 1 is rendered before the story begins;
   * scenes 2..N stream in during narration.
   */
  video_url?: string;
}

export interface ComposedLesson {
  /** Title of the whole lesson (1 line). */
  title: string;
  /** All scenes, in narration order. */
  scenes: Scene[];
  /** Total narration text (concatenation of scene narration_texts) — used by orchestrator if needed. */
  full_narration: string;
  /**
   * The language the script was composed in (detected from the listener's
   * topic prompt by lib/lesson/script-generator.ts). Drives downstream
   * TTS voice, STT language, and agent persona selection so the spoken
   * narration, speech recognition, and Q&A persona all match. Optional for
   * backwards compatibility — code paths that didn't set it default to
   * English in lib/language-config.ts.
   */
  language?: DetectedLanguage;
}

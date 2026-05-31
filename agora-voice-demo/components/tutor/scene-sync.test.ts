// Regression test for the 2026-05-31 "voice switched to Chinese but subtitle
// stayed English" bug. The fix routes segment_started.text into the displayed
// scene's narration_text; these tests pin that contract.
import { describe, it, expect } from 'vitest';
import { applyNarrationText } from './scene-sync';
import type { Scene } from './theme';

function scene(p: Partial<Scene> & { id: string }): Scene {
  return {
    chapter: 'Ch1',
    sceneNum: 'i',
    headline: ['A', 'B'],
    narration_text: 'English narration.',
    image_prompt: 'x',
    ...p,
  };
}

const SCENES: Scene[] = [
  scene({ id: 's1', narration_text: 'Albert watched the train.' }),
  scene({ id: 's2', narration_text: 'Light always flees at the same speed.' }),
];

describe('applyNarrationText (subtitle follows spoken text)', () => {
  it('replaces the matched scene narration with the rewritten (e.g. Chinese) text', () => {
    const out = applyNarrationText(SCENES, 's2', '光总是以同样的速度逃离。');
    expect(out[1].narration_text).toBe('光总是以同样的速度逃离。');
    expect(out[0].narration_text).toBe('Albert watched the train.'); // untouched
  });

  it('preserves all other scene fields', () => {
    const out = applyNarrationText(SCENES, 's2', '中文');
    expect(out[1]).toMatchObject({ id: 's2', chapter: 'Ch1', sceneNum: 'i', image_prompt: 'x' });
    expect(out[1].headline).toEqual(['A', 'B']);
  });

  it('returns the SAME array reference (no React churn) when id is unknown', () => {
    const out = applyNarrationText(SCENES, 'nope', '中文');
    expect(out).toBe(SCENES);
  });

  it('is a no-op for empty/whitespace text (never blanks the subtitle)', () => {
    expect(applyNarrationText(SCENES, 's1', '')).toBe(SCENES);
    expect(applyNarrationText(SCENES, 's1', '   ')).toBe(SCENES);
    expect(applyNarrationText(SCENES, 's1', undefined)).toBe(SCENES);
    expect(applyNarrationText(SCENES, 's1', null)).toBe(SCENES);
  });

  it('is a no-op (same reference) when the text already matches', () => {
    expect(applyNarrationText(SCENES, 's1', 'Albert watched the train.')).toBe(SCENES);
  });
});

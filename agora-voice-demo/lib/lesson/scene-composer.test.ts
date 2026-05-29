import { describe, it, expect } from 'vitest';
import { composeLesson } from './scene-composer';

const SHORT = 'Once upon a time. There was a tiny rabbit. She was very brave.';
const LONG = `In the beginning there was a quiet town. A clockmaker lived at the corner. Every morning she opened her shop. The cogs in her shop ticked in unison. One day a stranger arrived. He brought with him a curious watch. The watch had no hands at all. The clockmaker had never seen such a thing. She invited the stranger to sit. They talked late into the evening. The town clock chimed twelve. The stranger smiled and left.`;

describe('composeLesson — Phase A stub', () => {
  it('produces exactly target_scene_count scenes (default 6) when input is long', () => {
    const r = composeLesson(LONG);
    expect(r.scenes.length).toBe(6);
  });
  it('every scene has chapter / sceneNum / headline / narration_text / image_prompt', () => {
    const r = composeLesson(LONG);
    for (const s of r.scenes) {
      expect(s.chapter).toMatch(/^Chapter /);
      expect(s.sceneNum).toMatch(/^Scene /);
      expect(s.headline.length).toBe(2);
      expect(s.narration_text.length).toBeGreaterThan(0);
      expect(s.image_prompt.length).toBeGreaterThan(0);
      expect(s.image_url).toBeUndefined();
    }
  });
  it('full_narration concatenates all scene texts and roughly matches input length', () => {
    const r = composeLesson(LONG);
    // We allow some whitespace normalization but no content loss
    const inputWords = LONG.trim().split(/\s+/).length;
    const outputWords = r.full_narration.trim().split(/\s+/).length;
    expect(Math.abs(inputWords - outputWords)).toBeLessThan(5);
  });
  it('short input gets fewer scenes, not padded with empty', () => {
    const r = composeLesson(SHORT, { target_scene_count: 6 });
    expect(r.scenes.length).toBeGreaterThanOrEqual(1);
    expect(r.scenes.length).toBeLessThanOrEqual(6);
    for (const s of r.scenes) {
      expect(s.narration_text.length).toBeGreaterThan(0);
    }
  });
  it('title falls back when input has no clean first sentence', () => {
    const r = composeLesson('hello', { default_title: 'Fallback Title' });
    expect(r.title.length).toBeGreaterThan(0);
  });
  it('chapter words are spelled out (One, Two, …)', () => {
    const r = composeLesson(LONG);
    const chapters = r.scenes.map(s => s.chapter);
    expect(chapters[0]).toBe('Chapter One');
    if (chapters.length >= 2) expect(chapters[1]).toBe('Chapter Two');
  });
  it('sceneNum uses Roman numerals (I, II, III, …)', () => {
    const r = composeLesson(LONG);
    const nums = r.scenes.map(s => s.sceneNum);
    expect(nums[0]).toBe('Scene I');
    if (nums.length >= 2) expect(nums[1]).toBe('Scene II');
    if (nums.length >= 4) expect(nums[3]).toBe('Scene IV');
  });
});

import { describe, it, expect } from 'vitest';
import { estimateNarrationMs, splitToSegments } from './splitter';

// The subtitle clock. These tests pin the script-aware behavior that keeps
// captions from racing ahead of the voice — the 2026-05-31 regression where a
// flat 17-chars/sec rate (English) over-counted Chinese speed ~3x.

describe('estimateNarrationMs (script-aware subtitle clock)', () => {
  it('English text ~17 chars/sec', () => {
    // 51 chars / 17 ≈ 3000ms + 150 tail.
    const text = 'The quick brown fox jumps over the lazy dog today';
    const ms = estimateNarrationMs(text);
    // 49 latin chars * 58.8 ≈ 2882 + 150 ≈ 3032
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThan(3500);
  });

  it('Chinese text is estimated ~3x slower per char than the old flat rate', () => {
    const zh = '阿尔伯特坐在草地上看着天上的云'; // 15 CJK chars
    const ms = estimateNarrationMs(zh);
    // 15 * 200 = 3000 + 150 = 3150 (script-aware)
    expect(ms).toBeGreaterThan(2900);
    expect(ms).toBeLessThan(3400);
    // The OLD flat 17/sec rate would have said ~15/17*1000+150 ≈ 1032ms — ~3x too fast.
    const oldFlat = Math.max(700, Math.round((zh.length / 17) * 1000)) + 150;
    expect(ms).toBeGreaterThan(oldFlat * 2.5);
  });

  it('mixed Latin + CJK sums each script at its own rate', () => {
    const mixed = 'Albert 阿尔伯特'; // 7 latin (incl space) + 4 CJK
    const ms = estimateNarrationMs(mixed);
    // 7*58.8 + 4*200 = 411 + 800 = 1211 → max(700,1211)+150 = 1361
    expect(ms).toBeGreaterThan(1100);
    expect(ms).toBeLessThan(1600);
  });

  it('clamps a very short string to the 700ms floor (+tail)', () => {
    expect(estimateNarrationMs('Hi.')).toBe(700 + 150);
  });

  it('Chinese narration takes meaningfully longer than same-char-count English', () => {
    const en = 'abcdefghij'; // 10 latin
    const zh = '一二三四五六七八九十'; // 10 CJK
    expect(estimateNarrationMs(zh)).toBeGreaterThan(estimateNarrationMs(en) * 2.5);
  });
});

describe('splitToSegments uses the script-aware estimate', () => {
  it('a Chinese segment gets a CJK-rate duration, not a Latin-rate one', () => {
    const zh = '阿尔伯特坐在草地上，看着天上的云慢慢飘过，心里想着一个奇妙的问题。';
    const segs = splitToSegments(zh);
    expect(segs.length).toBeGreaterThan(0);
    const total = segs.reduce((a, s) => a + s.approx_duration_ms, 0);
    // CJK-rate: ~31 chars * 200 ≈ 6200ms. Old flat rate would be ~1800ms.
    expect(total).toBeGreaterThan(4000);
  });
});

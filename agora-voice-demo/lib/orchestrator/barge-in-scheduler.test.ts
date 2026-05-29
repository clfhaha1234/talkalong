import { describe, it, expect } from 'vitest';
import { classify } from './barge-in-scheduler';

describe('barge-in scheduler — Phase 3 stub', () => {
  it('always returns answer_now for now', () => {
    expect(classify({ question: 'wait, why?', remaining_segment_texts: [] })).toBe('answer_now');
    expect(classify({ question: 'hello', remaining_segment_texts: ['random'] })).toBe('answer_now');
  });

  it('exposes a stable type', () => {
    const decisions = ['answer_now', 'defer_to_segment', 'dismiss_gently'] as const;
    type _D = (typeof decisions)[number];
    const r: _D = classify({ question: 'x', remaining_segment_texts: [] });
    expect(decisions).toContain(r);
  });
});

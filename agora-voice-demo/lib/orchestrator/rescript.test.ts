import { describe, it, expect, vi } from 'vitest';
import { rescriptSegments } from './rescript';
import type { Segment } from './types';

function seg(id: string, text: string): Segment {
  return { id, range: { start: 0, end: text.length }, text, approx_duration_ms: 1000, category: 'exposition', elicitation_node: false };
}

describe('rescript LLM with watchdog', () => {
  it('returns rewritten segments when LLM resolves within budget', async () => {
    const originals = [seg('s4', 'The third step is X.'), seg('s5', 'After that, Y.')];
    const llm = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 's4', text: 'Since you asked about X, the third step is X-revised.' },
      { id: 's5', text: 'After that, Y-revised.' },
    ]));
    const res = await rescriptSegments(
      { originals, qa_history: [{ role: 'user', text: 'X?', ts: 0 }], depth_setting: 'default' },
      { llm, budget_ms: 3000 },
    );
    expect(res.source).toBe('llm');
    expect(res.segments.length).toBe(2);
    expect(res.segments[0].text).toContain('X-revised');
  });

  it('returns originals on timeout', async () => {
    const originals = [seg('s4', 'A.'), seg('s5', 'B.')];
    const llm = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const res = await rescriptSegments(
      { originals, qa_history: [], depth_setting: 'default' },
      { llm, budget_ms: 30 },
    );
    expect(res.source).toBe('fallback');
    expect(res.segments[0].text).toBe('A.');
  });

  it('returns originals on malformed LLM response', async () => {
    const originals = [seg('s4', 'A.')];
    const llm = vi.fn().mockResolvedValue('not json at all');
    const res = await rescriptSegments(
      { originals, qa_history: [], depth_setting: 'default' },
      { llm, budget_ms: 3000 },
    );
    expect(res.source).toBe('fallback');
  });
});

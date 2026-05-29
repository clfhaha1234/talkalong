import { describe, it, expect, vi } from 'vitest';
import { generateBridge } from './bridge';

describe('bridge LLM with watchdog', () => {
  it('returns LLM output when call resolves within budget', async () => {
    const llm = vi.fn().mockResolvedValue('Right — so to your question about X, we have the answer. Coming back to the main thread.');
    const res = await generateBridge(
      { qa_history: [{ role: 'user', text: 'why?', ts: 0 }, { role: 'agent', text: 'because.', ts: 1 }], paused_segment_text: 'The third step is...', next_segment_text: 'After that...' },
      { llm, budget_ms: 1500 },
    );
    expect(res.source).toBe('llm');
    expect(res.text.toLowerCase()).toContain('coming back');
  });

  it('falls back to library when LLM exceeds budget', async () => {
    const llm = vi.fn().mockImplementation(() => new Promise<string>(() => {})); // never resolves
    const res = await generateBridge(
      { qa_history: [], paused_segment_text: 's', next_segment_text: 'n' },
      { llm, budget_ms: 50 },
    );
    expect(res.source).toBe('fallback');
    expect(res.text.length).toBeGreaterThan(30);
  });

  it('falls back when LLM throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('429'));
    const res = await generateBridge(
      { qa_history: [], paused_segment_text: 's', next_segment_text: 'n' },
      { llm, budget_ms: 1500 },
    );
    expect(res.source).toBe('fallback');
  });
});

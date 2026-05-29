import { describe, it, expect } from 'vitest';
import { classifyTurn } from './classify-turn';
import { fakeLlm } from './testing';

describe('classifyTurn', () => {
  it('flags a HOW directive (language)', async () => {
    const llm = fakeLlm(['{"kind":"how","directive":{"type":"set_language","value":"ja"}}']);
    const c = await classifyTurn('話してください日本語で', llm);
    expect(c.kind).toBe('how');
    expect(c.directive?.type).toBe('set_language');
    expect(c.directive?.value).toBe('ja');
  });
  it('flags a WHAT violation (abandon task)', async () => {
    const llm = fakeLlm(['{"kind":"what","reason":"asks to abandon the story for jokes"}']);
    const c = await classifyTurn('stop the story, just tell me jokes', llm);
    expect(c.kind).toBe('what');
  });
  it('defaults to qa on unparseable output (safe, never throws)', async () => {
    const llm = fakeLlm(['not json at all']);
    const c = await classifyTurn('whatever', llm);
    expect(c.kind).toBe('qa');
  });
});

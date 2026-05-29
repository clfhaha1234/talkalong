import { describe, it, expect } from 'vitest';
import { decideElicitTurn } from './decide-elicit';
import { fakeLlm } from './testing';

const seg = { id: 'q1', kind: 'elicit' as const, question: 'Why this role?', target: 'a concrete motivation' };

describe('decideElicitTurn', () => {
  it('accepts an adequate answer', async () => {
    const llm = fakeLlm(['{"action":"accept","reason":"covers motivation"}']);
    const d = await decideElicitTurn({ segment: seg, answer: 'I love distributed systems and your scale', attempts: 0 }, llm);
    expect(d.action).toBe('accept');
  });
  it('follows up on a shallow answer with text', async () => {
    const llm = fakeLlm(['{"action":"follow_up","text":"What specifically draws you?"}']);
    const d = await decideElicitTurn({ segment: seg, answer: 'dunno, seems cool', attempts: 0 }, llm);
    expect(d.action).toBe('follow_up');
    expect(d.text).toMatch(/draws you/);
  });
  it('gives up after the cap regardless of model', async () => {
    const llm = fakeLlm(['{"action":"follow_up","text":"again?"}']);
    const d = await decideElicitTurn({ segment: seg, answer: null, attempts: 2, maxAttempts: 2 }, llm);
    expect(d.action).toBe('give_up'); // cap overrides the model
  });
  it('remediates (re-explains) on a wrong answer that shows misunderstanding', async () => {
    const llm = fakeLlm(['{"action":"remediate","text":"A feature flag is a switch that turns a feature on/off without redeploying."}']);
    const d = await decideElicitTurn({ segment: seg, answer: 'it changes the colors', attempts: 0 }, llm);
    expect(d.action).toBe('remediate');
    expect(d.text).toMatch(/switch/);
  });
});

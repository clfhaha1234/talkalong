import { describe, it, expect } from 'vitest';
import { makePersona } from './persona';
import { TranscriptActuator, fakeLlm } from './testing';

describe('makePersona', () => {
  it('silent persona returns silence and never calls the llm', async () => {
    let called = 0;
    const llm = async () => { called++; return 'x'; };
    const act = new TranscriptActuator();
    await act.speak('Why this role?');
    const p = makePersona({ kind: 'silent' }, llm, act);
    expect(await p.nextUserTurn()).toEqual({ kind: 'silence' });
    expect(called).toBe(0);
  });

  it('cooperative persona replies with text based on the last agent utterance', async () => {
    const act = new TranscriptActuator();
    await act.speak('Why this role?');
    const llm = fakeLlm(['I admire your engineering culture and scale.']);
    const p = makePersona({ kind: 'cooperative' }, llm, act);
    const turn = await p.nextUserTurn();
    expect(turn.kind).toBe('text');
    if (turn.kind === 'text') expect(turn.text).toMatch(/engineering culture/);
  });

  it('meta persona emits its scripted directive utterance first, then cooperates', async () => {
    const act = new TranscriptActuator();
    await act.speak('Tell me about a hard project.');
    const llm = fakeLlm(['It was a migration under deadline.']);
    const p = makePersona({ kind: 'meta', metaUtterance: 'please switch to Japanese' }, llm, act);
    const t1 = await p.nextUserTurn();
    expect(t1).toEqual({ kind: 'text', text: 'please switch to Japanese' });
    const t2 = await p.nextUserTurn();
    expect(t2.kind).toBe('text'); // afterwards behaves cooperatively
  });
});

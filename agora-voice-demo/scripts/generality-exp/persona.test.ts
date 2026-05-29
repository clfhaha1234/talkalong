import { describe, it, expect } from 'vitest';
import { makePersona } from './persona';
import { TranscriptActuator, fakeLlm } from './testing';

describe('makePersona', () => {
  it('silent persona returns silence and never calls the llm', async () => {
    let called = 0;
    const llm = async () => { called++; return 'x'; };
    const act = new TranscriptActuator();
    await act.speak('Why this role?');
    const p = makePersona({ kind: 'silent' }, llm, () => act.spoken.at(-1) ?? '');
    expect(await p.nextUserTurn()).toEqual({ kind: 'silence' });
    expect(called).toBe(0);
  });

  it('cooperative persona replies with text based on the last agent utterance', async () => {
    const act = new TranscriptActuator();
    await act.speak('Why this role?');
    const llm = fakeLlm(['I admire your engineering culture and scale.']);
    const p = makePersona({ kind: 'cooperative' }, llm, () => act.spoken.at(-1) ?? '');
    const turn = await p.nextUserTurn();
    expect(turn.kind).toBe('text');
    if (turn.kind === 'text') expect(turn.text).toMatch(/engineering culture/);
  });

  it('wrong-corrigible persona is not silent: calls the llm and returns a text turn', async () => {
    let called = 0;
    const act = new TranscriptActuator();
    await act.speak('In your own words, what does a feature flag let us do?');
    const llm = async () => { called++; return 'Um, it makes the app faster?'; };
    const p = makePersona({ kind: 'wrong-corrigible' }, llm, () => act.spoken.at(-1) ?? '');
    const turn = await p.nextUserTurn();
    expect(called).toBe(1);
    expect(turn.kind).toBe('text');
    if (turn.kind === 'text') expect(turn.text).toBe('Um, it makes the app faster?');
  });

  it('meta persona emits its scripted directive utterance first, then cooperates', async () => {
    const act = new TranscriptActuator();
    await act.speak('Tell me about a hard project.');
    const llm = fakeLlm(['It was a migration under deadline.']);
    const p = makePersona({ kind: 'meta', metaUtterance: 'please switch to Japanese' }, llm, () => act.spoken.at(-1) ?? '');
    const t1 = await p.nextUserTurn();
    expect(t1).toEqual({ kind: 'text', text: 'please switch to Japanese' });
    const t2 = await p.nextUserTurn();
    expect(t2.kind).toBe('text'); // afterwards behaves cooperatively
  });
});

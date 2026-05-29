import { describe, it, expect } from 'vitest';
import { TranscriptActuator, ScriptedListener, fakeLlm } from './testing';

describe('test doubles', () => {
  it('TranscriptActuator records speech', async () => {
    const a = new TranscriptActuator();
    await a.speak('hello');
    expect(a.spoken).toEqual(['hello']);
  });
  it('ScriptedListener returns turns then silence', async () => {
    const l = new ScriptedListener([{ kind: 'text', text: 'hi' }]);
    expect(await l.nextUserTurn()).toEqual({ kind: 'text', text: 'hi' });
    expect(await l.nextUserTurn()).toEqual({ kind: 'silence' });
  });
  it('fakeLlm returns the queued response', async () => {
    const llm = fakeLlm(['{"action":"accept"}']);
    expect(await llm('any prompt')).toBe('{"action":"accept"}');
  });
});

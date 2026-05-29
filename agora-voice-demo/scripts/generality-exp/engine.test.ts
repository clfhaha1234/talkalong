import { describe, it, expect } from 'vitest';
import { runAgenda } from './engine';
import { TranscriptActuator, ScriptedListener, fakeLlm } from './testing';
import type { Agenda, Listener, UserTurn } from './types';

class AlwaysListener implements Listener {
  constructor(private turn: UserTurn) {}
  async nextUserTurn(): Promise<UserTurn> { return this.turn; }
}

const deliverOnly: Agenda = { id: 'story', title: 'Story', segments: [
  { id: 's1', kind: 'deliver', text: 'Lina crept toward the tree.', load_bearing: true },
  { id: 's2', kind: 'deliver', text: 'A grey fox watched her.', load_bearing: true },
]};

describe('engine — deliver-only', () => {
  it('speaks every segment in order, no listener needed', async () => {
    const act = new TranscriptActuator();
    const t = await runAgenda(deliverOnly, act, new ScriptedListener([]), fakeLlm([]), {});
    expect(act.spoken).toEqual(['Lina crept toward the tree.', 'A grey fox watched her.']);
    expect(t.coverage.delivered).toEqual(['s1', 's2']);
  });
});

const elicitOnly: Agenda = { id: 'hr', title: 'HR', segments: [
  { id: 'q1', kind: 'elicit', question: 'Why this role?', target: 'a concrete motivation', load_bearing: true },
]};

describe('engine — elicit', () => {
  it('accepts an adequate answer and advances', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([{ kind: 'text', text: 'I love your scale' }]);
    const llm = fakeLlm(['{"kind":"answer"}', '{"action":"accept"}']); // classify, then decide
    const t = await runAgenda(elicitOnly, act, listener, llm, {});
    expect(t.coverage.covered).toContain('q1');
  });
  it('gives up gracefully on persistent silence (teacher continues)', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([]); // always silence
    const llm = fakeLlm(['{"action":"give_up"}']);
    const t = await runAgenda(elicitOnly, act, listener, llm, { maxAttempts: 2 });
    expect(t.coverage.given_up).toContain('q1');
    expect(act.spoken.join(' ')).toMatch(/move on|alright|let's/i); // a graceful bridge was spoken
  });
  it('stops eliciting when the user says stop (HOW directive → spine flag)', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([{ kind: 'text', text: 'please stop asking me questions' }]);
    const llm = fakeLlm(['{"kind":"how","directive":{"type":"stop_eliciting"}}']);
    const t = await runAgenda(elicitOnly, act, listener, llm, {});
    expect(t.flags.elicitation_enabled).toBe(false);
    expect(t.coverage.skipped_policy).toContain('q1');
  });
  it('terminates under an unbounded HOW stream (does not hang)', async () => {
    const act = new TranscriptActuator();
    const listener = new AlwaysListener({ kind: 'text', text: 'slower please' });
    const llm = fakeLlm(['{"kind":"how","directive":{"type":"set_pace","value":"slow"}}']); // forever
    const t = await runAgenda(elicitOnly, act, listener, llm, { maxTurns: 8 });
    expect(t.coverage.given_up).toContain('q1'); // ceiling fired → graceful give-up
  });
});

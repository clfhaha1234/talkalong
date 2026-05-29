import { describe, it, expect } from 'vitest';
import { transition, isTerminalState } from './state-machine';
import type { OuterState, FsmEvent } from './state-machine';

describe('outer FSM transitions', () => {
  it('IDLE + session_start → MAIN', () => {
    expect(transition('IDLE', { type: 'session_start' })).toBe('MAIN');
  });
  it('MAIN + barge_in → BRANCH', () => {
    expect(transition('MAIN', { type: 'barge_in' })).toBe('BRANCH');
  });
  it('BRANCH + resume_complete → MAIN', () => {
    expect(transition('BRANCH', { type: 'resume_complete' })).toBe('MAIN');
  });
  it('MAIN + all_done → DONE', () => {
    expect(transition('MAIN', { type: 'all_done' })).toBe('DONE');
  });
  it('ANY + error → ERROR', () => {
    expect(transition('MAIN', { type: 'error', message: 'x' })).toBe('ERROR');
    expect(transition('BRANCH', { type: 'error', message: 'x' })).toBe('ERROR');
    expect(transition('IDLE', { type: 'error', message: 'x' })).toBe('ERROR');
  });
  it('throws on undefined transitions', () => {
    expect(() => transition('DONE', { type: 'session_start' })).toThrow(
      /no transition: DONE \+ session_start/,
    );
    expect(() => transition('ERROR', { type: 'session_start' })).toThrow(
      /no transition: ERROR \+ session_start/,
    );
  });
  it('isTerminalState: DONE and ERROR are terminal; others are not', () => {
    expect(isTerminalState('DONE')).toBe(true);
    expect(isTerminalState('ERROR')).toBe(true);
    expect(isTerminalState('IDLE')).toBe(false);
    expect(isTerminalState('MAIN')).toBe(false);
    expect(isTerminalState('BRANCH')).toBe(false);
  });
});

//
// Outer state machine for the tutor session.
//
// States: IDLE → MAIN ↔ BRANCH → DONE; any state can transition to ERROR.
// Pure logic — no IO. Transitions are total over the (state × event) table
// in design doc §2.1; undefined combinations throw to catch bugs early.

export type OuterState = 'IDLE' | 'MAIN' | 'BRANCH' | 'DONE' | 'ERROR';

export type FsmEvent =
  | { type: 'session_start' }
  | { type: 'barge_in' }
  | { type: 'resume_complete' }
  | { type: 'all_done' }
  | { type: 'error'; message: string };

export function transition(state: OuterState, event: FsmEvent): OuterState {
  if (event.type === 'error') return 'ERROR';
  const key = `${state}+${event.type}` as const;
  switch (key) {
    case 'IDLE+session_start': return 'MAIN';
    case 'MAIN+barge_in': return 'BRANCH';
    case 'BRANCH+resume_complete': return 'MAIN';
    case 'MAIN+all_done': return 'DONE';
    default:
      throw new Error(`no transition: ${state} + ${event.type}`);
  }
}

export function isTerminalState(s: OuterState): boolean {
  return s === 'DONE' || s === 'ERROR';
}

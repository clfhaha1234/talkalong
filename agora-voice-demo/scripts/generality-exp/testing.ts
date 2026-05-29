import type { Actuator, Listener, UserTurn } from './types';

export class TranscriptActuator implements Actuator {
  spoken: string[] = [];
  async speak(text: string): Promise<void> { this.spoken.push(text); }
}

export class ScriptedListener implements Listener {
  private i = 0;
  constructor(private turns: UserTurn[]) {}
  async nextUserTurn(): Promise<UserTurn> { return this.turns[this.i++] ?? { kind: 'silence' }; }
}

export function fakeLlm(responses: string[]): (p: string) => Promise<string> {
  let i = 0;
  return async () => responses[i++] ?? responses[responses.length - 1] ?? '';
}

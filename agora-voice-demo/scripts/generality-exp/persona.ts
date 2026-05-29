import type { Listener, UserTurn, Actuator } from './types';
import { TranscriptActuator } from './testing';

export type PersonaSpec =
  | { kind: 'silent' }
  | { kind: 'cooperative' | 'rambling' | 'shallow' }
  | { kind: 'meta'; metaUtterance: string };

const FLAVOR: Record<string, string> = {
  cooperative: 'You answer concisely and substantively, directly addressing what was asked.',
  rambling: 'You go off on tangents and over-share unrelated detail before (maybe) getting to the point.',
  shallow: 'You give a thin, vague, low-effort answer that does not really address the question.',
};

export function makePersona(spec: PersonaSpec, llm: (p: string) => Promise<string>, actuator: Actuator): Listener {
  let metaDone = false;
  return {
    async nextUserTurn(): Promise<UserTurn> {
      if (spec.kind === 'silent') return { kind: 'silence' };
      if (spec.kind === 'meta' && !metaDone) { metaDone = true; return { kind: 'text', text: spec.metaUtterance }; }
      const flavor = spec.kind === 'meta' ? FLAVOR.cooperative : FLAVOR[spec.kind];
      const lastAgent = (actuator as TranscriptActuator).spoken.at(-1) ?? '';
      const prompt = `You are role-playing a person in a voice conversation. ${flavor}\nThe other party just said: "${lastAgent}"\nReply in ONE short spoken utterance, no quotes, no labels.`;
      const text = (await llm(prompt)).trim();
      return { kind: 'text', text };
    },
  };
}

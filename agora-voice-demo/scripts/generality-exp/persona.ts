import type { Listener, UserTurn, Llm } from './types';

export type PersonaSpec =
  | { kind: 'silent' }
  | { kind: 'cooperative' | 'rambling' | 'shallow' }
  | { kind: 'wrong-corrigible' }
  | { kind: 'meta'; metaUtterance: string };

const FLAVOR: Record<string, string> = {
  cooperative: 'You answer concisely and substantively, directly addressing what was asked.',
  rambling: 'You go off on tangents and over-share unrelated detail before (maybe) getting to the point.',
  shallow: 'You give a thin, vague, low-effort answer that does not really address the question.',
};

// `lastSpoken` reads the most recent agent utterance — supplied across the
// injected-I/O boundary by whoever wires the run, so the persona never reaches
// into a concrete actuator implementation.
export function makePersona(spec: PersonaSpec, llm: Llm, lastSpoken: () => string): Listener {
  let metaDone = false;
  return {
    async nextUserTurn(): Promise<UserTurn> {
      if (spec.kind === 'silent') return { kind: 'silence' };
      if (spec.kind === 'meta' && !metaDone) { metaDone = true; return { kind: 'text', text: spec.metaUtterance }; }
      const lastAgent = lastSpoken();
      let prompt: string;
      if (spec.kind === 'wrong-corrigible') {
        prompt = `You are a slow learner answering a tutor. RULE: if the tutor's most recent message EXPLAINED or TAUGHT the concept (gave you new information to understand it), answer correctly using what they just explained. If the tutor merely ASKED or RE-PHRASED the question WITHOUT explaining the concept, you are still confused — give a plausible but WRONG answer. The tutor just said: "${lastAgent}". Reply in ONE short spoken utterance, no quotes.`;
      } else {
        const flavor = FLAVOR[spec.kind] ?? FLAVOR.cooperative;
        prompt = `You are role-playing a person in a voice conversation. ${flavor}\nThe other party just said: "${lastAgent}"\nReply in ONE short spoken utterance, no quotes, no labels.`;
      }
      const text = (await llm(prompt)).trim();
      return { kind: 'text', text };
    },
  };
}

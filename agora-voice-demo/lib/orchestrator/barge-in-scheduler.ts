//
// Phase 3 scope: ships answer_now-only. The other two decisions
// (defer_to_segment, dismiss_gently) are stubbed for the typed surface but
// always fall through to answer_now. Phase 5 / 7 will train a real classifier.

export type BargeInDecision = 'answer_now' | 'defer_to_segment' | 'dismiss_gently';

export interface ClassifyArgs {
  question: string;
  remaining_segment_texts: string[];
}

export function classify(_args: ClassifyArgs): BargeInDecision {
  return 'answer_now';
}

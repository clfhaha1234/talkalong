import type { ElicitSegment } from './types';

export interface ElicitDecision { action: 'accept' | 'follow_up' | 'give_up'; text?: string; reason?: string; }
export interface ElicitInput { segment: ElicitSegment; answer: string | null; attempts: number; maxAttempts?: number; }

const SYSTEM = `You decide how an interviewer/teacher handles a listener's answer to a question.
Output ONE JSON object, no prose: {"action":"accept"|"follow_up"|"give_up","text":"<if follow_up, the next question, 1 sentence>","reason":"<=10 words"}.
- accept: the answer adequately covers the target.
- follow_up: partial/shallow — ask ONE focused follow-up for the missing piece.
- give_up: the listener is silent/evasive and pressing further would be rude.
Warm, in-character, no meta-preface.`;

export async function decideElicitTurn(input: ElicitInput, llm: (p: string) => Promise<string>): Promise<ElicitDecision> {
  // Code-enforced cap: never trust the model to stop. These run BEFORE the LLM call.
  const cap = input.maxAttempts ?? 2;
  if (input.attempts >= cap) return { action: 'give_up', reason: 'attempt cap reached' };
  if (input.answer === null && input.attempts >= 1) return { action: 'give_up', reason: 'repeated silence' };

  const answerLine = input.answer === null ? '(silence — no answer)' : input.answer;
  const prompt = `${SYSTEM}\n\nQuestion: ${input.segment.question}\nTarget (what an adequate answer surfaces): ${input.segment.target}\nListener answer: ${answerLine}\nAttempts so far: ${input.attempts}\n\nJSON:`;
  const raw = await llm(prompt);
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (['accept', 'follow_up', 'give_up'].includes(j.action)) return j;
  } catch { /* fall through */ }
  return { action: 'give_up', reason: 'unparseable decision' }; // safe default: never loop forever
}

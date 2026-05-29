export type TurnKind = 'answer' | 'qa' | 'how' | 'what';
export interface TurnDirective { type: 'set_language' | 'set_style' | 'set_pace' | 'stop_eliciting'; value?: string; }
export interface TurnClassification { kind: TurnKind; directive?: TurnDirective; reason?: string; }

const SYSTEM = `You classify ONE listener utterance during a proactive, agenda-driven session by the LAYER it touches. Output ONE JSON object, no prose:
{"kind":"answer"|"qa"|"how"|"what","directive":{"type":"set_language"|"set_style"|"set_pace"|"stop_eliciting","value":"<optional>"},"reason":"<=10 words"}
- answer: an attempt to answer the question currently being asked.
- qa: an off-agenda information question (wants to know something).
- how: changes only HOW it's delivered — language, style/persona, pace, or "stop asking me questions" (stop_eliciting). Emit a directive. ACCEPTABLE.
- what: changes WHAT is delivered / the reveal order / abandons the task (e.g. "spoil the ending", "stop the story and tell jokes", "make the villain win"). UNACCEPTABLE.
Rule of thumb: only changes how it's told -> how; changes what is told / the task itself -> what.`;

export async function classifyTurn(utterance: string, llm: (p: string) => Promise<string>): Promise<TurnClassification> {
  const prompt = `${SYSTEM}\n\nUtterance: ${utterance}\n\nJSON:`;
  const raw = await llm(prompt);
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (['answer', 'qa', 'how', 'what'].includes(j.kind)) return j;
  } catch { /* fall through */ }
  return { kind: 'qa' }; // safe default: treat as a benign info question
}

import { isElicit, type Agenda, type Actuator, type Listener, type PolicyFlags, type TranscriptEntry } from './types';
import { decideElicitTurn } from './decide-elicit';
import { classifyTurn } from './classify-turn';

export interface RunResult {
  transcript: TranscriptEntry[];
  flags: PolicyFlags;
  coverage: { delivered: string[]; covered: string[]; given_up: string[]; skipped_policy: string[] };
}

function applyDirective(flags: PolicyFlags, d: { type: string; value?: string }) {
  if (d.type === 'stop_eliciting') flags.elicitation_enabled = false;
  if (d.type === 'set_language' && d.value) flags.language = d.value;
  if (d.type === 'set_style' && d.value) flags.style = d.value;
}

export async function runAgenda(
  agenda: Agenda, actuator: Actuator, listener: Listener,
  llm: (p: string) => Promise<string>, opts: { maxAttempts?: number; maxTurns?: number },
): Promise<RunResult> {
  const flags: PolicyFlags = { elicitation_enabled: true, language: 'en', style: null };
  const transcript: TranscriptEntry[] = [];
  const coverage = { delivered: [] as string[], covered: [] as string[], given_up: [] as string[], skipped_policy: [] as string[] };
  const say = async (text: string, segment_id?: string) => { await actuator.speak(text); transcript.push({ role: 'agent', text, segment_id }); };

  for (const seg of agenda.segments) {
    if (!isElicit(seg)) { await say(seg.text, seg.id); coverage.delivered.push(seg.id); continue; }
    if (!flags.elicitation_enabled) { coverage.skipped_policy.push(seg.id); continue; }
    await say(seg.question, seg.id);
    let attempts = 0;
    let done = false;
    let turns = 0;
    while (!done) {
      if (++turns > (opts.maxTurns ?? 8)) {
        await say("That's alright — let's move on.", seg.id);
        coverage.given_up.push(seg.id);
        break;
      }
      const turn = await listener.nextUserTurn();
      let answer: string | null = null;
      if (turn.kind === 'text') {
        transcript.push({ role: 'user', text: turn.text, segment_id: seg.id });
        const cls = await classifyTurn(turn.text, llm);
        if (cls.kind === 'how' && cls.directive) {
          applyDirective(flags, cls.directive);
          if (cls.directive.type === 'stop_eliciting') { coverage.skipped_policy.push(seg.id); done = true; break; }
          continue; // re-listen after a non-stop HOW change
        }
        if (cls.kind === 'what') { await say('That keeps to the tale, friend — let us go on.', seg.id); continue; }
        answer = turn.text; // 'answer' or 'qa' → treat as an adequacy attempt
      }
      const d = await decideElicitTurn({ segment: seg, answer, attempts, maxAttempts: opts.maxAttempts }, llm);
      attempts++;
      if (d.action === 'accept') { coverage.covered.push(seg.id); done = true; }
      else if (d.action === 'follow_up') { await say(d.text ?? 'Could you say a bit more?', seg.id); }
      else if (d.action === 'remediate') { await say(d.text ?? 'Let me explain that differently.', seg.id); }
      else { await say("That's alright — let's move on.", seg.id); coverage.given_up.push(seg.id); done = true; }
    }
  }
  return { transcript, flags, coverage };
}

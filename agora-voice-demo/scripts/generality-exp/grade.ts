import type { Agenda } from './types';
import type { RunResult } from './engine';

export interface Grade {
  load_bearing_total: number;
  load_bearing_reached: number;
  coverage_ok: boolean;
  given_up_ids: string[];
  graceful_ok: boolean;
  forbidden_hits: number;
  pass: boolean;
}

const GRACE = /move on|alright|let's|let us go on/i;

export function gradeRun(result: RunResult, agenda: Agenda, opts: { forbidden?: string[] } = {}): Grade {
  const { delivered, covered, given_up } = result.coverage;
  const reached = new Set([...delivered, ...covered, ...given_up]); // given_up = gracefully reached, NOT dropped
  const lb = agenda.segments.filter((s) => s.load_bearing);
  const load_bearing_reached = lb.filter((s) => reached.has(s.id)).length;
  const coverage_ok = load_bearing_reached === lb.length;

  const agentText = result.transcript.filter((e) => e.role === 'agent');
  // If anyone was given up on, a graceful bridge must have been spoken somewhere.
  const graceful_ok = given_up.length === 0 || agentText.some((e) => GRACE.test(e.text));

  const forbidden = opts.forbidden ?? [];
  const allAgent = agentText.map((e) => e.text.toLowerCase()).join('\n');
  const forbidden_hits = forbidden.filter((f) => allAgent.includes(f.toLowerCase())).length;

  return {
    load_bearing_total: lb.length, load_bearing_reached, coverage_ok,
    given_up_ids: given_up, graceful_ok, forbidden_hits,
    pass: coverage_ok && graceful_ok && forbidden_hits === 0,
  };
}

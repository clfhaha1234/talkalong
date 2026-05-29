import { describe, it, expect } from 'vitest';
import { gradeRun } from './grade';
import type { Agenda } from './types';
import type { RunResult } from './engine';

const agenda: Agenda = { id: 'mix', title: 'm', segments: [
  { id: 'd1', kind: 'deliver', text: 'hello', load_bearing: true },
  { id: 'q1', kind: 'elicit', question: 'why?', target: 't', load_bearing: true },
  { id: 'q2', kind: 'elicit', question: 'extra?', target: 't', load_bearing: false },
]};

function res(partial: Partial<RunResult['coverage']>, transcript: RunResult['transcript'] = []): RunResult {
  return { transcript, flags: { elicitation_enabled: true, language: 'en', style: null },
    coverage: { delivered: [], covered: [], given_up: [], skipped_policy: [], ...partial } };
}

describe('gradeRun', () => {
  it('passes when all load-bearing segments are reached', () => {
    const g = gradeRun(res({ delivered: ['d1'], covered: ['q1'] }), agenda);
    expect(g.coverage_ok).toBe(true);
    expect(g.load_bearing_reached).toBe(2);
    expect(g.load_bearing_total).toBe(2);
  });
  it('counts a graceful give_up as reached (not dropped)', () => {
    const g = gradeRun(res({ delivered: ['d1'], given_up: ['q1'] },
      [{ role: 'agent', text: "That's alright — let's move on.", segment_id: 'q1' }]), agenda);
    expect(g.coverage_ok).toBe(true);
    expect(g.graceful_ok).toBe(true);
  });
  it('fails coverage when a load-bearing segment was dropped by policy', () => {
    const g = gradeRun(res({ delivered: ['d1'], skipped_policy: ['q1'] }), agenda);
    expect(g.coverage_ok).toBe(false); // q1 load-bearing but only skipped_policy → not reached
  });
  it('flags a forbidden substring (WHAT violation)', () => {
    const g = gradeRun(res({ delivered: ['d1'], covered: ['q1'] },
      [{ role: 'agent', text: 'and the queen lived happily — spoiler!' }]), agenda, { forbidden: ['the queen lived'] });
    expect(g.forbidden_hits).toBeGreaterThan(0);
    expect(g.pass).toBe(false);
  });
});

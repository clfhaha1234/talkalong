// Unit tests for the pure logic in run-latency-lib.mjs.
//
// The audio-barge-in README claims:
//   "The pure logic (deriveLatencies, percentiles, bands, budget split) is
//    unit-tested on synthetic timelines"
//   "A drift guard greps the source so the harness constant can't silently
//    fall out of sync"
//
// Both claims were aspirational until this file landed. The lib was extracted
// from run-latency.mjs (which has a top-level main() that launches Playwright,
// so it can't be imported directly into vitest without side effects).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BANDS,
  KNOWN_FIXED,
  band,
  deriveSeamLatencies,
  deriveLatencies,
  pct,
  resumeBudget,
} from './run-latency-lib.mjs';

describe('band()', () => {
  it('returns — for null', () => {
    expect(band(null, BANDS.t1_pause)).toBe('—');
  });
  it('returns 🟢 when ms <= good', () => {
    expect(band(0, BANDS.t1_pause)).toBe('🟢');
    expect(band(600, BANDS.t1_pause)).toBe('🟢'); // boundary inclusive
  });
  it('returns 🟡 when good < ms <= ok', () => {
    expect(band(601, BANDS.t1_pause)).toBe('🟡');
    expect(band(1200, BANDS.t1_pause)).toBe('🟡'); // boundary inclusive
  });
  it('returns 🔴 when ms > ok', () => {
    expect(band(1201, BANDS.t1_pause)).toBe('🔴');
    expect(band(99999, BANDS.t1_pause)).toBe('🔴');
  });
});

describe('deriveSeamLatencies() — branch-post tripwire', () => {
  it('marks a healthy barge-in when listening, branch_post, STT, answer, and resume all happen', () => {
    const result = deriveSeamLatencies(
      [
        { t: 1000, ev: 'mic_live' },
        { t: 6100, ev: 'state', detail: 'listening' },
        { t: 6125, ev: 'branch_post', detail: '1' },
        { t: 6400, ev: 'user_txt', detail: 'What is the cat name?' },
        { t: 7600, ev: 'state', detail: 'speaking' },
        { t: 9000, ev: 'state', detail: 'idle' },
        { t: 10600, ev: 'segment', detail: 's2' },
        { t: 10700, ev: 'qa_post', detail: '1' },
      ],
      5000,
    );

    expect(result.t1_pause_ms).toBe(100);
    expect(result.branch_posted).toBe(true);
    expect(result.branch_post_ms).toBe(25);
    expect(result.stt_ok).toBe(true);
    expect(result.t2_reply_ms).toBe(1500);
    expect(result.t3_resume_ms).toBe(1600);
  });

  it('fails the server-pause contract when a user question transcribes but branch_post is missing', () => {
    const result = deriveSeamLatencies(
      [
        { t: 1000, ev: 'mic_live' },
        { t: 6100, ev: 'state', detail: 'listening' },
        { t: 6400, ev: 'user_txt', detail: 'Hello? Can you hear me?' },
        { t: 7600, ev: 'state', detail: 'speaking' },
        { t: 9000, ev: 'state', detail: 'idle' },
        { t: 10600, ev: 'segment', detail: 's3' },
      ],
      5000,
    );

    expect(result.stt_ok).toBe(true);
    expect(result.branch_posted).toBe(false);
    // Latency can look fine while the backend state contract is broken; this is
    // the bug class the old bench missed.
    expect(result.t2_reply_ms).toBe(1500);
  });
});

describe('pct()', () => {
  it('returns null for empty input', () => {
    expect(pct([], 50)).toBeNull();
    expect(pct([null, null], 50)).toBeNull();
  });
  it('returns the only value for a single sample', () => {
    expect(pct([1234], 50)).toBe(1234);
    expect(pct([1234], 95)).toBe(1234);
  });
  it('filters nulls before computing', () => {
    expect(pct([null, 100, null, 200, null], 50)).toBe(100);
  });
  it('nearest-rank percentile on a sorted array', () => {
    // ceil(50/100 * 10) = 5 → index 4 → value 50
    expect(pct([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50)).toBe(50);
    // ceil(95/100 * 10) = 10 → index 9 → value 100
    expect(pct([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
  });
  it('handles unsorted input', () => {
    expect(pct([300, 100, 200], 50)).toBe(200);
  });
});

describe('deriveLatencies()', () => {
  // Helper to build a synthetic snapshot timeline. Each entry: { t, inBranch?, answerText?, nowReading? }
  const tl = (entries: Array<Record<string, unknown>>) => entries as never;

  it('full happy path → all 4 latencies populated', () => {
    const result = deriveLatencies(
      tl([
        { t: 0, inBranch: false, nowReading: true },
        { t: 100, inBranch: false, nowReading: true }, // pre-interrupt
        { t: 5100, inBranch: false, nowReading: true }, // post-interrupt, still no branch
        { t: 5500, inBranch: true, answerText: '' }, // branch fires
        { t: 6800, inBranch: true, answerText: 'Mosk has reasons.' }, // answer appears
        { t: 9500, inBranch: false, nowReading: true }, // resumed
      ]),
      5000,
    );
    expect(result.interrupt_ms).toBe(5000);
    expect(result.t1_pause_ms).toBe(500);  // 5500 - 5000
    expect(result.t2_reply_ms).toBe(1300); // 6800 - 5500
    expect(result.t3_resume_ms).toBe(2700); // 9500 - 6800
  });

  it('no branch event → t1/t2/t3 all null', () => {
    const result = deriveLatencies(
      tl([
        { t: 0, inBranch: false, nowReading: true },
        { t: 5500, inBranch: false, nowReading: true },
      ]),
      5000,
    );
    expect(result.t1_pause_ms).toBeNull();
    expect(result.t2_reply_ms).toBeNull();
    expect(result.t3_resume_ms).toBeNull();
  });

  it('branch but no answer → t1 valid, t2/t3 null', () => {
    const result = deriveLatencies(
      tl([
        { t: 5200, inBranch: true, answerText: '' },
        { t: 9000, inBranch: true, answerText: '' },
      ]),
      5000,
    );
    expect(result.t1_pause_ms).toBe(200);
    expect(result.t2_reply_ms).toBeNull();
    expect(result.t3_resume_ms).toBeNull();
  });

  it('answer but no resume → t1/t2 valid, t3 null', () => {
    const result = deriveLatencies(
      tl([
        { t: 5200, inBranch: true, answerText: '' },
        { t: 6000, inBranch: true, answerText: 'hi' },
      ]),
      5000,
    );
    expect(result.t1_pause_ms).toBe(200);
    expect(result.t2_reply_ms).toBe(800);
    expect(result.t3_resume_ms).toBeNull();
  });

  it('treats single-char answerText as empty (length > 1 filter)', () => {
    const result = deriveLatencies(
      tl([
        { t: 5200, inBranch: true, answerText: 'h' }, // single char — ignored
        { t: 6800, inBranch: true, answerText: 'hi' },
      ]),
      5000,
    );
    expect(result.t2_reply_ms).toBe(1600); // counts from branch (5200) to "hi" (6800)
  });

  it('ignores branch events that fire BEFORE interrupt onset', () => {
    const result = deriveLatencies(
      tl([
        { t: 1000, inBranch: true }, // earlier (spurious — must be ignored)
        { t: 5500, inBranch: true }, // post-interrupt — counts
      ]),
      5000,
    );
    expect(result.t1_pause_ms).toBe(500);
  });
});

describe('resumeBudget()', () => {
  it('returns null live_ms when t3 is null', () => {
    expect(resumeBudget(null, 2000)).toEqual({ fixed_ms: 2000, live_ms: null });
  });
  it('typical case: live = t3 - fixed', () => {
    expect(resumeBudget(3500, 2000)).toEqual({ fixed_ms: 2000, live_ms: 1500 });
  });
  it('clamps to 0 when fixed > t3 (rapid back-and-forth case)', () => {
    expect(resumeBudget(1500, 2000)).toEqual({ fixed_ms: 2000, live_ms: 0 });
  });
});

describe('drift guard: SILENCE_TIMEOUT_MS source = harness constant', () => {
  // The harness constant `KNOWN_FIXED.silence_confirm_ms` mirrors the app-side
  // after-answer `SILENCE_TIMEOUT_MS` in components/TutorPage.tsx (1400ms as of
  // 2026-06-01; a separate SILENCE_NO_ANSWER_MS handles false barges). If either
  // moves without the other, the report's "fixed wait vs live work" split
  // becomes a lie. Grep the source and assert equality.
  it('matches the constant declared in components/TutorPage.tsx', () => {
    const tutorPagePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'components',
      'TutorPage.tsx',
    );
    const src = readFileSync(tutorPagePath, 'utf8');
    const m = src.match(/const\s+SILENCE_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const sourceValue = Number(m![1]);
    expect(sourceValue).toBe(KNOWN_FIXED.silence_confirm_ms);
  });
});

describe('BANDS sanity', () => {
  it('every band has good <= ok', () => {
    for (const [_name, b] of Object.entries(BANDS)) {
      expect(b.good).toBeLessThanOrEqual(b.ok);
    }
  });
  it('total band is the largest', () => {
    expect(BANDS.total.good).toBeGreaterThanOrEqual(BANDS.t1_pause.good);
    expect(BANDS.total.good).toBeGreaterThanOrEqual(BANDS.t2_reply.good);
    expect(BANDS.total.good).toBeGreaterThanOrEqual(BANDS.t3_resume.good);
  });
});

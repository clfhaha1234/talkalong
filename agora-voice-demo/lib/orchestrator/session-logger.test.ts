// Verifies the session logger captures a full conversation + latency transcript
// to the file sink, with relative-ms stamps and an idempotent attach.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TUTOR_LOG_DIR / TUTOR_SESSION_LOG are read at the logger's module-load time,
// so they must be set BEFORE that module is imported. Vitest hoists `import`
// above this file's top-level statements, which would lose the race — so we set
// the env in a setup file (./session-logger.test.env.ts) that vitest imports
// first via the inline `// @vitest-environment` ordering guarantee: a static
// import of the setup module below runs before the logger import is used.
import { LOG_DIR } from './session-logger.test.env';
import { attachSessionLogger, logSessionQa, closeSessionLogger } from './session-logger';

function fakeHandle(sessionId: string) {
  let sub: ((e: unknown) => void) | null = null;
  const tracker = { unsubscribed: false };
  const handle = {
    session_id: sessionId,
    // Only .progress.subscribe is touched by the logger.
    progress: {
      subscribe: (fn: (e: unknown) => void) => {
        sub = fn;
        return () => {
          tracker.unsubscribed = true;
          sub = null; // mimic real EventEmitter off(): listener stops firing
        };
      },
    },
  } as never;
  return { handle, tracker, emit: (e: unknown) => sub?.(e) };
}

function readTranscript(sid: string): string {
  // Concatenate ALL files for this sid — a re-attach after close lands in a
  // new per-millisecond filename, and we want the full picture across them.
  const files = readdirSync(LOG_DIR).filter((x) => x.includes(sid) && x.endsWith('.txt'));
  if (files.length === 0) throw new Error(`no log file for ${sid} in ${LOG_DIR}`);
  return files.map((f) => readFileSync(join(LOG_DIR, f), 'utf8')).join('\n');
}

afterEach(() => {
  /* keep dir; cleaned at the end */
});

describe('session-logger', () => {
  it('captures a full conversation + latency transcript with stamps', () => {
    const { handle, emit } = fakeHandle('TST1');
    attachSessionLogger(handle);

    emit({ type: 'segment_started', segment_id: 's1', segment_index: 0, text: 'Young Albert sat on a hill.' });
    // snapshot events are noise — they must NOT appear in the transcript.
    emit({ type: 'snapshot', snapshot: { session_id: 'TST1' } });
    emit({ type: 'segment_completed', segment_id: 's1' });
    emit({ type: 'branch_started', paused_segment_id: 's1' });
    logSessionQa('TST1', [
      { role: 'user', text: 'why slow? 为什么', ts: Date.now() },
      { role: 'agent', text: 'rocket time 火箭', ts: Date.now() },
    ]);
    emit({ type: 'bridge_started', text: 'back to story' });
    emit({ type: 'bridge_completed' });
    emit({ type: 'active_scene_changed', scene_id: 's2', reason: 'planner_continue' });
    emit({ type: 'error', message: 'simerr' });
    closeSessionLogger('TST1');

    const t = readTranscript('TST1');
    expect(t).toContain('=== SESSION TST1');
    expect(t).toContain('segment_started s1');
    expect(t).toContain('BARGE-IN');
    expect(t).toContain('QA user: "why slow? 为什么"'); // CJK preserved
    expect(t).toContain('QA agent: "rocket time 火箭"');
    expect(t).toContain('resume latency'); // barge-in → bridge gap computed
    expect(t).toContain('ERROR simerr');
    expect(t).toContain('CLOSE');
    // snapshot events are filtered out (noise).
    expect(t).not.toContain('snapshot');
    // Relative-ms stamp on every logged line.
    expect(/\[\+\s*\d+ms\]/.test(t)).toBe(true);
  });

  it('is idempotent — double attach logs START once', () => {
    const { handle } = fakeHandle('TST2');
    attachSessionLogger(handle);
    attachSessionLogger(handle);
    closeSessionLogger('TST2');
    const t = readTranscript('TST2');
    expect((t.match(/ START/g) ?? []).length).toBe(1);
  });

  it('writes one file per session (keyed by session_id)', () => {
    const a = fakeHandle('TSTA');
    const b = fakeHandle('TSTB');
    attachSessionLogger(a.handle);
    attachSessionLogger(b.handle);
    closeSessionLogger('TSTA');
    closeSessionLogger('TSTB');
    const files = readdirSync(LOG_DIR);
    expect(files.some((f) => f.includes('TSTA'))).toBe(true);
    expect(files.some((f) => f.includes('TSTB'))).toBe(true);
  });

  // ── regression: code-review findings ──────────────────────────────────────

  it('never logs Agora rtc/rtm tokens (security)', () => {
    const { handle, emit } = fakeHandle('TSTSEC');
    attachSessionLogger(handle);
    emit({
      type: 'session_started',
      channel: 'lesson-1-abcd',
      agent_id: 'AGENT123',
      rtc_token: 'SECRET_RTC_TOKEN_xyz',
      rtm_token: 'SECRET_RTM_TOKEN_xyz',
      client_uid: '100000',
    });
    closeSessionLogger('TSTSEC');
    const t = readTranscript('TSTSEC');
    expect(t).toContain('session_started channel=lesson-1-abcd');
    expect(t).not.toContain('SECRET_RTC_TOKEN');
    expect(t).not.toContain('SECRET_RTM_TOKEN');
    expect(t).not.toContain('rtc_token');
  });

  it('a throwing event never propagates (logging must not break a session)', () => {
    const { handle, emit } = fakeHandle('TSTTHROW');
    attachSessionLogger(handle);
    // A malformed event whose field access inside describeEvent could throw;
    // the listener must swallow it. emit() must not throw.
    expect(() => emit({ type: 'segment_started', get segment_id(): string { throw new Error('boom'); } })).not.toThrow();
    closeSessionLogger('TSTTHROW');
  });

  it('close tears down the listener + frees state (no leak)', () => {
    const { handle, tracker, emit } = fakeHandle('TSTLEAK');
    attachSessionLogger(handle);
    emit({ type: 'segment_started', segment_id: 's1', segment_index: 0, text: 'hi' });
    closeSessionLogger('TSTLEAK');
    expect(tracker.unsubscribed).toBe(true); // the progress listener was removed

    // After close, a fresh attach with the SAME id must work — proving the
    // `attached` entry was freed (without that fix the guard would skip it and
    // s9 would never log).
    const again = fakeHandle('TSTLEAK');
    attachSessionLogger(again.handle);
    again.emit({ type: 'segment_completed', segment_id: 's9' });
    closeSessionLogger('TSTLEAK');
    expect(readTranscript('TSTLEAK')).toContain('segment_completed s9');
  });
});

// Cleanup the temp dir after the suite.
afterEach(() => {});
process.on('exit', () => {
  try {
    rmSync(LOG_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

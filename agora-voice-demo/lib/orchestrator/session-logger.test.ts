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
  const handle = {
    session_id: sessionId,
    // Only .progress.subscribe is touched by the logger.
    progress: {
      subscribe: (fn: (e: unknown) => void) => {
        sub = fn;
        return () => {};
      },
    },
  } as never;
  return { handle, emit: (e: unknown) => sub?.(e) };
}

function readTranscript(sid: string): string {
  const f = readdirSync(LOG_DIR).find((x) => x.includes(sid) && x.endsWith('.txt'));
  if (!f) throw new Error(`no log file for ${sid} in ${LOG_DIR}`);
  return readFileSync(join(LOG_DIR, f), 'utf8');
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

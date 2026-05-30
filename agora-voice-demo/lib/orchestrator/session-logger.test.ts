// Verifies the session logger captures a full conversation + latency transcript
// to the file sink, with relative-ms stamps and an idempotent attach.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // A malformed event that makes describeEvent's default-branch JSON.stringify
    // throw (circular reference). The listener's try/catch must swallow it so
    // the throw never bubbles back through EventEmitter.emit() into narration.
    const circular: Record<string, unknown> = { type: 'weird_unknown_event' };
    circular.self = circular;
    expect(() => emit(circular)).not.toThrow();
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

  // Defensive: qa-ended can fire for a session whose attachSessionLogger never
  // ran on this module instance (split-bundle / cross-route, the exact bug
  // 4145e67 fixed via globalThis). logSessionQa must NOT crash on the unknown
  // sid — it should still emit to the console sink (no file path), with the
  // fallback "?ms" stamp so the line still correlates by sid.
  it('logSessionQa for an unknown session — no crash, falls through to console-only', () => {
    expect(() =>
      logSessionQa('NEVER_ATTACHED', [
        { role: 'user', text: 'hello' },
        { role: 'agent', text: 'hi' },
      ]),
    ).not.toThrow();
    // The unknown session has no file path, so no file appears in LOG_DIR for it.
    const files = readdirSync(LOG_DIR);
    expect(files.some((f) => f.includes('NEVER_ATTACHED'))).toBe(false);
  });

  // Symmetric defensive: closeSessionLogger for an unknown sid is a no-op.
  it('closeSessionLogger for an unknown session — no crash', () => {
    expect(() => closeSessionLogger('NEVER_ATTACHED_2')).not.toThrow();
  });

  // bridge_started can arrive WITHOUT a preceding barge-in (e.g. agent-initiated
  // recap). The "resume latency" annotation must only fire when there's a real
  // gap to measure — otherwise the log gets a meaningless 0ms or stale-state
  // number.
  it('bridge_started without preceding branch_started does NOT log "resume latency"', () => {
    const { handle, emit } = fakeHandle('TSTC');
    attachSessionLogger(handle);
    emit({ type: 'segment_started', segment_id: 's1', text: 'opening' });
    emit({ type: 'bridge_started', text: 'agent recap' }); // no branch_started before
    emit({ type: 'bridge_completed' });
    closeSessionLogger('TSTC');

    const t = readTranscript('TSTC');
    expect(t).toContain('bridge_started');
    expect(t).not.toContain('resume latency');
  });

  // describeEvent has a JSON fallback for event types the switch doesn't know
  // about. New event shapes in the progress stream should still appear in the
  // log, not be silently dropped.
  it('unknown event types fall through to JSON-tail formatting', () => {
    const { handle, emit } = fakeHandle('TSTD');
    attachSessionLogger(handle);
    emit({ type: 'some_future_event', some_field: 42, nested: { ok: true } });
    closeSessionLogger('TSTD');

    const t = readTranscript('TSTD');
    expect(t).toContain('some_future_event');
    expect(t).toContain('"some_field":42');
  });

  // QA text > 200 chars gets truncated in the log line to keep file size
  // bounded. Verify the cap holds — important for long user paste-ins.
  it('logSessionQa truncates per-turn text to 200 chars', () => {
    const { handle } = fakeHandle('TSTE');
    attachSessionLogger(handle);
    const long = 'X'.repeat(500);
    logSessionQa('TSTE', [{ role: 'user', text: long }]);
    closeSessionLogger('TSTE');

    const t = readTranscript('TSTE');
    // Find the QA line and measure the text inside the quotes.
    const m = t.match(/QA user: "(X+)"/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBe(200);
  });

  // Static wire-guard. Commit 419f3dc fixed the bug "logger module + tests
  // existed but nothing called attachSessionLogger — the feature was inert".
  // This is the kind of bug a merge-and-lose-an-edit can silently
  // re-introduce. Assert the call site is present in index.ts so any future
  // accidental unwiring is caught by `pnpm test`.
  it('index.ts wires attachSessionLogger at the buildTutorHandle seam', () => {
    const indexSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
      'utf8',
    );
    // Robust to extra named imports on the same line (e.g. closeSessionLogger).
    expect(indexSrc).toMatch(/import\s*\{[^}]*\battachSessionLogger\b[^}]*\}\s*from\s*'\.\/session-logger'/);
    // At least one call site exists (buildTutorHandle covers both
    // startTutorSession and startTutorSessionFromScenes).
    expect((indexSrc.match(/attachSessionLogger\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  // Same wire-guard for the qa-ended route — logSessionQa was wired in
  // 419f3dc alongside the index.ts attach. If a future merge drops this
  // import + call, the conversation-text side of the log goes dark while
  // event timestamps keep flowing, which is exactly the partial-breakage
  // mode the original bug had.
  it('qa-ended route wires logSessionQa', () => {
    const routeSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'app',
        'api',
        'tutor',
        'qa-ended',
        'route.ts',
      ),
      'utf8',
    );
    expect(routeSrc).toContain('logSessionQa');
    expect((routeSrc.match(/logSessionQa\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
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

// session-logger.ts — per-session conversation + latency log for debugging
// real sessions ("看线上实际对话情况 + 延迟").
//
// TWO SINKS, picked by environment (the deploy target is Vercel):
//   1. console — ALWAYS. One structured line per entry, prefixed `[session-log]`
//      and tagged with the session_id. On Vercel these land in the dashboard /
//      `vercel logs` (filter by session_id to reconstruct a conversation); on
//      local `pnpm dev` they print to the terminal. This is the ONLY sink that
//      works on serverless, where the filesystem is read-only.
//   2. file — ONLY when a writable FS is available (local dev / self-hosted).
//      Appends to <TUTOR_LOG_DIR>/<ts>-<sid>.txt so you get a tidy per-session
//      transcript on disk. Auto-skipped on Vercel (process.env.VERCEL set) and
//      on any write error — logging must NEVER break a session.
//
// Gating: on by default; set TUTOR_SESSION_LOG=0 to disable entirely.
//
// Wiring: call attachSessionLogger(handle) once after the session handle is
// built (it's idempotent — safe to call from multiple code paths). It subscribes
// to the progress-event stream, so narration timing, barge-in, resume bridge,
// active-scene changes and errors are all captured with relative-ms timestamps.
// Conversation Q&A content is logged separately via logSessionQa() from the
// qa-ended route (that's where the turn text arrives).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { RunTutorHandle } from './index';
import type { ProgressEvent } from './types';

const ENABLED = process.env.TUTOR_SESSION_LOG !== '0';
// Vercel sets VERCEL=1; its FS is read-only outside /tmp, so skip the file sink.
const FILE_SINK = ENABLED && !process.env.VERCEL;
const LOG_DIR = process.env.TUTOR_LOG_DIR || 'logs/sessions';

// Per-session bookkeeping. Keyed by session_id so the qa-ended route (a
// separate request, possibly a separate Vercel instance) can still emit
// correlated console lines even without the in-memory file handle.
interface SessionLogState {
  startedAt: number;
  filePath: string | null;
  lastBranchAt: number | null; // for resume-latency (branch_started → bridge_started)
}
const states = new Map<string, SessionLogState>();
const attached = new WeakSet<object>();

function stamp(ms: number): string {
  return `[+${String(ms).padStart(6, ' ')}ms]`;
}

function nowMinus(startedAt: number): number {
  return Date.now() - startedAt;
}

function writeLine(sid: string, line: string): void {
  if (!ENABLED) return;
  // Sink 1 — console (works on Vercel + local).
  console.log(`[session-log] ${sid} ${line}`);
  // Sink 2 — file (local / self-hosted only).
  const st = states.get(sid);
  if (FILE_SINK && st?.filePath) {
    try {
      appendFileSync(st.filePath, line + '\n');
    } catch {
      // disk full / read-only / racing teardown — never break the session.
    }
  }
}

function describeEvent(e: ProgressEvent): string {
  // Format known events readably; fall back to compact JSON for the rest.
  const anyE = e as Record<string, unknown>;
  switch (e.type) {
    case 'segment_started':
      return `segment_started ${anyE.segment_id} "${String(anyE.text ?? '').slice(0, 70)}"`;
    case 'segment_completed':
      return `segment_completed ${anyE.segment_id}`;
    case 'branch_started':
      return `BARGE-IN (branch_started)`;
    case 'branch_ended':
      return `branch_ended`;
    case 'bridge_started':
      return `bridge_started "${String(anyE.text ?? '').slice(0, 70)}"`;
    case 'bridge_completed':
      return `bridge_completed`;
    case 'active_scene_changed':
      return `active_scene_changed → ${anyE.scene_id} (${anyE.reason})`;
    case 'narration_complete':
      return `narration_complete`;
    case 'error':
      return `ERROR ${anyE.message}`;
    default: {
      const { type, ...rest } = anyE;
      const tail = Object.keys(rest).length ? ' ' + JSON.stringify(rest).slice(0, 120) : '';
      return `${String(type)}${tail}`;
    }
  }
}

/**
 * Attach the logger to a live session. Idempotent. Subscribes to the progress
 * stream so all narration / barge-in / resume / error events are logged with
 * relative-ms timestamps. Safe to call from any number of code paths.
 */
export function attachSessionLogger(handle: RunTutorHandle): void {
  if (!ENABLED) return;
  if (attached.has(handle)) return;
  attached.add(handle);

  const sid = handle.session_id;
  const startedAt = Date.now();
  let filePath: string | null = null;

  if (FILE_SINK) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      // Filesystem-safe timestamp (no colons); sortable.
      const iso = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
      filePath = `${LOG_DIR}/${iso}-${sid}.txt`;
      writeFileSync(
        filePath,
        `=== SESSION ${sid} · ${new Date(startedAt).toISOString()} ===\n`,
      );
    } catch {
      filePath = null; // read-only FS or similar — fall back to console only.
    }
  }

  states.set(sid, { startedAt, filePath, lastBranchAt: null });

  const log = (line: string) => writeLine(sid, `${stamp(nowMinus(startedAt))} ${line}`);
  log(`START${filePath ? ` · file=${filePath}` : ' · console-only'}`);

  handle.progress.subscribe((e: ProgressEvent) => {
    const st = states.get(sid);
    if (e.type === 'branch_started' && st) st.lastBranchAt = Date.now();
    // Resume latency = gap from barge-in to the bridge actually starting —
    // entirely within this one long-lived SSE invocation, so reliable on Vercel.
    if (e.type === 'bridge_started' && st?.lastBranchAt != null) {
      log(`↳ resume latency ${Date.now() - st.lastBranchAt}ms (barge-in → bridge)`);
      st.lastBranchAt = null;
    }
    log(describeEvent(e));
  });
}

/**
 * Log the conversation turns captured at qa-ended (where the Q&A text arrives).
 * Console-tagged by session_id so it correlates with the event stream even when
 * qa-ended runs in a different Vercel instance from the SSE stream.
 */
export function logSessionQa(
  sessionId: string,
  qaHistory: Array<{ role: 'user' | 'agent'; text: string; ts?: number }>,
): void {
  if (!ENABLED) return;
  const st = states.get(sessionId);
  const rel = (ts?: number) =>
    st && ts ? stamp(ts - st.startedAt) : '[+    ?ms]';
  writeLine(sessionId, `${rel(Date.now())} qa-ended · ${qaHistory.length} turn(s)`);
  for (const turn of qaHistory) {
    writeLine(sessionId, `${rel(turn.ts)} QA ${turn.role}: "${turn.text.slice(0, 200)}"`);
  }
}

/** Flush + drop per-session state on close. */
export function closeSessionLogger(sessionId: string): void {
  const st = states.get(sessionId);
  if (st) writeLine(sessionId, `${stamp(nowMinus(st.startedAt))} CLOSE`);
  states.delete(sessionId);
}

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

// Per-session bookkeeping. Keyed by session_id so the qa-ended route can find
// the session the lesson/start SSE path created.
interface SessionLogState {
  startedAt: number;
  filePath: string | null;
  lastBranchAt: number | null; // for resume-latency (branch_started → bridge_started)
  unsubscribe: (() => void) | null; // progress listener teardown, called on close
}

// CRITICAL: stash on globalThis, NOT a module-scoped `const`. In Next.js dev,
// and across separately-bundled route handlers, each route can get its own copy
// of this module's graph — a module-scoped Map would make lesson/start and
// qa-ended write to DIFFERENT Maps, so logSessionQa (in qa-ended) couldn't find
// the session attachSessionLogger (in the SSE path) created, dropping the Q&A
// turns + their timestamps from the file. This is the same hazard, and the same
// fix, as session-registry.ts.
declare global {
  // eslint-disable-next-line no-var
  var __tutorSessionLogStates: Map<string, SessionLogState> | undefined;
  // eslint-disable-next-line no-var
  var __tutorSessionLogAttached: Set<string> | undefined;
}
const states: Map<string, SessionLogState> =
  globalThis.__tutorSessionLogStates ?? (globalThis.__tutorSessionLogStates = new Map());
// Idempotency guard keyed by session_id (was a WeakSet on the handle; a string
// Set survives across the module-graph boundary the same way `states` does).
const attached: Set<string> =
  globalThis.__tutorSessionLogAttached ?? (globalThis.__tutorSessionLogAttached = new Set());

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
    case 'session_started':
      // NEVER log rtc_token / rtm_token — they are live Agora join credentials
      // and the console sink reaches production (Vercel) logs. Log only the
      // non-sensitive identifiers.
      return `session_started channel=${anyE.channel} agent_id=${anyE.agent_id} client_uid=${anyE.client_uid}`;
    default: {
      // Defense-in-depth: strip any *token*/secret-ish key so a future event
      // type can't leak credentials through this fallback.
      const { type, ...rest } = anyE;
      for (const k of Object.keys(rest)) {
        if (/token|secret|password|key/i.test(k)) rest[k] = '<redacted>';
      }
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
  if (attached.has(handle.session_id)) return;
  attached.add(handle.session_id);

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

  const state: SessionLogState = { startedAt, filePath, lastBranchAt: null, unsubscribe: null };
  states.set(sid, state);

  const log = (line: string) => writeLine(sid, `${stamp(nowMinus(startedAt))} ${line}`);
  log(`START${filePath ? ` · file=${filePath}` : ' · console-only'}`);

  // The listener runs inside ProgressState's EventEmitter.emit(), which is
  // called synchronously on the narration/resume hot path. A throw here would
  // bubble through emit() and break the session — so the ENTIRE body is wrapped:
  // logging must NEVER break a session (the load-bearing invariant of this file).
  state.unsubscribe = handle.progress.subscribe((e: ProgressEvent) => {
    try {
      // `snapshot` fires after almost every other event and is a truncated dump
      // of internal pointer state — pure noise in a human-readable debug log (it
      // was ~50% of every transcript). The meaningful lifecycle events below
      // carry the same information in readable form, so drop snapshots.
      if (e.type === 'snapshot') return;
      const st = states.get(sid);
      if (e.type === 'branch_started' && st) st.lastBranchAt = Date.now();
      // Resume latency = gap from barge-in to the bridge actually starting —
      // entirely within this one long-lived SSE invocation, so reliable on Vercel.
      if (e.type === 'bridge_started' && st?.lastBranchAt != null) {
        log(`↳ resume latency ${Date.now() - st.lastBranchAt}ms (barge-in → bridge)`);
        st.lastBranchAt = null;
      }
      log(describeEvent(e));
    } catch {
      // never let a logging failure propagate into emit() and break narration.
    }
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

/**
 * Flush + drop ALL per-session resources on close. Must be called when a
 * session ends (wired into handle.stop) so nothing leaks for the process
 * lifetime: the progress listener is removed, and both globalThis maps drop
 * their entries. Idempotent + never throws (logging must not break teardown).
 */
export function closeSessionLogger(sessionId: string): void {
  const st = states.get(sessionId);
  if (st) {
    writeLine(sessionId, `${stamp(nowMinus(st.startedAt))} CLOSE`);
    try {
      st.unsubscribe?.();
    } catch {
      // teardown best-effort; never throw out of close.
    }
  }
  states.delete(sessionId);
  attached.delete(sessionId); // else id is permanently "attached" → leak + a
  // reused id would be silently skipped by attachSessionLogger's guard.
}

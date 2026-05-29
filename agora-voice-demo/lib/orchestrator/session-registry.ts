// lib/orchestrator/session-registry.ts
//
// Phase 3 in-memory registry of active sessions. Production will replace this
// with a durable store (Redis, KV) when we need horizontal scale.
//
// HMR survival: in Next.js dev mode each route handler can hot-reload its
// module graph independently. A module-scoped `const REG = new Map()` then
// becomes route-private — POST /api/tutor/start writes to one Map, POST
// /api/tutor/qa-ended reads from a different empty Map. Stashing on
// globalThis keeps the same Map instance across hot reloads and across
// independently-bundled route handlers.

import type { RunTutorHandle } from './index';

declare global {
  // eslint-disable-next-line no-var
  var __talkthroughSessionRegistry: Map<string, RunTutorHandle> | undefined;
}

function regMap(): Map<string, RunTutorHandle> {
  if (!globalThis.__talkthroughSessionRegistry) {
    globalThis.__talkthroughSessionRegistry = new Map();
  }
  return globalThis.__talkthroughSessionRegistry;
}

export function register(handle: RunTutorHandle): void {
  regMap().set(handle.session_id, handle);
}

export function unregister(session_id: string): void {
  regMap().delete(session_id);
}

export function get(session_id: string): RunTutorHandle | undefined {
  return regMap().get(session_id);
}

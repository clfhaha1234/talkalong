// Pure transcript-mapping logic, extracted from TutorPage.tsx so it can be
// unit-tested WITHOUT a browser / Agora session. This is the code where the
// two manually-found bugs lived:
//
//   C1 — subtitle attribution: the old code decided user-vs-agent by uid
//        (`uid === '0' || uid === localUid`). Agora normalises the agent's uid
//        to '0' on the receiver, so the AGENT's turns got labelled as the
//        user's question → "right-side subtitle ≠ what was said". Fixed by
//        reading the authoritative `metadata.object` subtype.
//
//   C2 — qa_history pollution: narrator-side say() text arrives as
//        `assistant.transcription` items BETWEEN segments; without a branch
//        gate they piled into qa_history and shipped to the resume planner as
//        fake Q&A turns (1 real turn → 4-6 polluted). Fixed by dropping items
//        whose _time predates the active branch.
//
// Keeping this as a pure function means a vitest can replay synthetic
// transcript items (including the exact pollution + mis-attribution scenarios)
// and assert the output — so neither bug can silently come back.

import {
  MessageType,
  TurnStatus,
  type AgentTranscription,
  type TranscriptHelperItem,
  type UserTranscription,
} from 'agora-agent-client-toolkit';

export type QaRole = 'user' | 'agent';

export interface QaTranscriptTurn {
  role: QaRole;
  text: string;
  ts: number;
}

export interface MapTranscriptOptions {
  /** The browser's local RTC uid (publisher). Used as the last-resort
   *  user-attribution signal when metadata.object is absent. */
  localUid: string;
  /** Wall-clock ms when the current BRANCH started (speaking→listening), or
   *  null when no branch is active. Items before this (minus a grace window)
   *  are narration and are dropped. */
  branchStartedAt: number | null;
  /** Grace window (ms) before branchStartedAt within which an item is still
   *  kept — covers the small race where TRANSCRIPT_UPDATED fires just before
   *  the agent-state effect flips the branch flag. Default 500. */
  graceMs?: number;
  /** Max turns to retain (most recent). Default 20. */
  keep?: number;
}

type Item = TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>;

/**
 * Decide whether a single transcript item belongs to the user or the agent.
 * Authoritative signal is metadata.object (user.transcription vs
 * assistant.transcription); falls back to a positive localUid match only when
 * metadata is absent. NEVER use `uid === '0'` as a user signal — that's the C1
 * bug (agent uid normalises to '0').
 */
export function attributeRole(item: Item, localUid: string): QaRole {
  const obj = item.metadata?.object;
  if (obj === MessageType.USER_TRANSCRIPTION) return 'user';
  if (obj === MessageType.AGENT_TRANSCRIPTION) return 'agent';
  return item.uid === localUid ? 'user' : 'agent';
}

/**
 * The most recent AGENT transcript text across the items — i.e. what the agent
 * is saying RIGHT NOW (Agora grows this word-by-word as the TTS plays). Used to
 * drive the audio-synced narration reveal (see reveal-sync.ts). Returns null if
 * no agent item carries text yet. Unlike mapTranscriptItems this is NOT gated to
 * the branch window — during MAIN the narration itself arrives as
 * assistant.transcription, which is exactly the signal we want here.
 */
export function latestAgentText(items: Item[], localUid: string): string | null {
  let best: { text: string; t: number } | null = null;
  for (const item of items) {
    if (attributeRole(item, localUid) !== 'agent') continue;
    if (!item.text || item.text.trim().length === 0) continue;
    const t = typeof item._time === 'number' ? item._time : 0;
    if (!best || t >= best.t) best = { text: item.text, t };
  }
  return best ? best.text : null;
}

/**
 * Map raw TRANSCRIPT_UPDATED items into the committed Q&A turn list.
 * Applies the branch-window filter (C2) and role attribution (C1).
 */
export function mapTranscriptItems(
  items: Item[],
  opts: MapTranscriptOptions,
): QaTranscriptTurn[] {
  const grace = opts.graceMs ?? 500;
  const keep = opts.keep ?? 20;
  const branchStart = opts.branchStartedAt;

  const committed = items
    // Only finalised turns — IN_PROGRESS items are partial and would churn.
    .filter((item) => item.status !== TurnStatus.IN_PROGRESS)
    // C2: drop anything outside the active branch window (narration tail).
    .filter((item) => {
      if (branchStart === null) return false; // no active branch → nothing is Q&A
      if (typeof item._time === 'number' && item._time < branchStart - grace) {
        return false;
      }
      return true;
    })
    // C1: attribute role by metadata.object, not uid heuristics.
    .map((item) => ({
      role: attributeRole(item, opts.localUid),
      text: item.text,
      ts: item._time,
    }))
    .filter((t) => t.text && t.text.trim().length > 0);

  return committed.slice(-keep);
}

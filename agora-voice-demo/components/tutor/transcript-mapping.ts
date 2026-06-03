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
  /** Main-line narration texts for the current lesson. Any agent transcript that
   *  is just a substring of these texts is narration leakage, not a QA answer. */
  narrationTexts?: string[];
}

type Item = TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>;

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”"'.!?;:,—–-]/g, '')
    .trim();
}

function looksLikeNarrationLeak(text: string, narrationTexts: string[] = []): boolean {
  const norm = normalizeText(text);
  if (norm.length < 24) return false;
  return narrationTexts.some((narration) => {
    const scene = normalizeText(narration);
    return scene.length >= norm.length && scene.includes(norm);
  });
}

function stripLeadingNarrationLeak(text: string, narrationTexts: string[] = []): string {
  if (!narrationTexts.length) return text;
  const parts = text.match(/[^.!?]+[.!?]+|\S[\s\S]*$/g) ?? [text];
  let i = 0;
  while (i < parts.length && looksLikeNarrationLeak(parts[i], narrationTexts)) {
    i += 1;
  }
  return parts.slice(i).join(' ').replace(/\s+/g, ' ').trim();
}

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
 * The IN-PROGRESS user transcript text — what the user is saying RIGHT NOW, the
 * partial STT echo for the live "Listening…" bubble. Returns null if there is no
 * in-progress user turn.
 *
 * CRITICAL: only IN_PROGRESS turns count. Once a user turn FINALISES
 * (END/INTERRUPTED) it's committed into qaHistory and rendered as a normal user
 * bubble — if we kept returning it here, the live bubble at the foot of the feed
 * would duplicate that committed bubble (the "字幕出现2次" bug, 2026-05-31).
 */
export function latestUserText(items: Item[], localUid: string): string | null {
  return latestUserTurn(items, localUid)?.text ?? null;
}

export function latestUserTurn(
  items: Item[],
  localUid: string,
): { text: string; ts: number } | null {
  let best: { text: string; t: number } | null = null;
  for (const item of items) {
    if (attributeRole(item, localUid) !== 'user') continue;
    if (item.status !== TurnStatus.IN_PROGRESS) continue;
    if (!item.text || item.text.trim().length === 0) continue;
    const t = typeof item._time === 'number' ? item._time : 0;
    if (!best || t >= best.t) best = { text: item.text, t };
  }
  return best ? { text: best.text, ts: best.t } : null;
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
    .map((t) =>
      t.role === 'agent'
        ? { ...t, text: stripLeadingNarrationLeak(t.text, opts.narrationTexts) }
        : t,
    )
    .filter((t) => t.text && t.text.trim().length > 0)
    // C3: narrator leakage AFTER branch start. On Render/live Agora, the
    // interrupted main-line say() can still finalize an assistant transcript
    // after branchStartedAt; time-gating alone then mis-renders it as
    // "IN ANSWER TO YOU". Drop agent turns that are exact narration substrings.
    .filter(
      (t) =>
        t.role !== 'agent' ||
        !looksLikeNarrationLeak(t.text, opts.narrationTexts),
    );

  return committed.slice(-keep);
}

/**
 * Drop near-simultaneous duplicate turns. A typed question is BOTH pushed
 * locally (typedTurnsRef, so it shows instantly) AND echoed back by Agora as a
 * user.transcription in the RTM stream — so the naive [...committed, ...typed]
 * merge rendered the SAME question twice (live-verified on the Vercel deploy,
 * 2026-05-31). Keep the first occurrence of a given role+text and drop any
 * identical one within `windowMs` (the echo arrives within a couple seconds);
 * a genuinely-repeated question far apart in time is preserved.
 *
 * windowMs is deliberately TIGHT (4s): the sendText→RTM echo round-trips in
 * ~1-2s, while a child re-asking the same short question ("why?", "什么?") can
 * legitimately recur a handful of seconds apart — a wide window (the old 15s)
 * would silently swallow those genuine repeats. 4s clears the echo without
 * eating real re-asks.
 */
export function dedupeQaTurns(
  turns: QaTranscriptTurn[],
  windowMs = 4000,
): QaTranscriptTurn[] {
  const out: QaTranscriptTurn[] = [];
  for (const t of turns) {
    const norm = t.text.trim().toLowerCase();
    const isDup = out.some(
      (o) =>
        o.role === t.role &&
        o.text.trim().toLowerCase() === norm &&
        Math.abs(o.ts - t.ts) <= windowMs,
    );
    if (!isDup) out.push(t);
  }
  return out;
}

/**
 * Drop agent turns that occur BEFORE the first user turn in the branch.
 *
 * In a branch the only agent speech that can precede the question is the
 * leftover narration tail — the `say()` that was still mid-flight when the
 * listener barged in (the interrupt takes a round-trip to land). That is NOT an
 * answer; the q/a pairing would render it as a phantom "IN ANSWER TO YOU" bubble
 * with an empty question (live-found 2026-06-01: the first bubble was scene-1
 * narration the listener hadn't asked about). An answer must follow a question —
 * so anything before the first user turn is discarded. If there's no user turn
 * yet, there are no answers to show.
 */
export function dropLeadingAgentTurns(turns: QaTranscriptTurn[]): QaTranscriptTurn[] {
  const firstUser = turns.findIndex((t) => t.role === 'user');
  if (firstUser === -1) return turns.filter((t) => t.role === 'user');
  return turns.slice(firstUser);
}

/**
 * Merge consecutive same-role turns into one.
 *
 * Agora finalizes a single spoken answer in MULTIPLE chunks, each arriving as
 * its own transcript turn — so one answer rendered as several "IN ANSWER TO YOU"
 * bubbles (live-found 2026-06-01). Joining adjacent same-role turns gives the
 * storyteller's natural shape: one question → one answer. This is safe inside a
 * branch because the narrator is PAUSED there, so consecutive agent turns are
 * all part of the same reply — never fresh narration getting swallowed.
 *
 * Handles the growing-transcript case (a later chunk is a superset/extension of
 * an earlier one) so we don't double up overlapping text.
 */
export function coalesceConsecutiveTurns(
  turns: QaTranscriptTurn[],
): QaTranscriptTurn[] {
  const out: QaTranscriptTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    const text = t.text.trim();
    if (!last || last.role !== t.role) {
      out.push({ role: t.role, text, ts: t.ts });
      continue;
    }
    const prev = last.text;
    if (text === prev || prev.includes(text)) {
      // exact dup or already contained — keep the longer, advance ts
    } else if (text.startsWith(prev)) {
      last.text = text; // the chunk grew the previous one
    } else {
      last.text = `${prev} ${text}`;
    }
    last.ts = Math.max(last.ts, t.ts);
  }
  return out;
}

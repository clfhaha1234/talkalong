// Regression tests for the two transcript bugs found by hand 2026-05-30:
//   C1 — subtitle attribution (agent uid normalised to '0' → mislabelled user)
//   C2 — qa_history pollution (narration tail leaking into Q&A turns)
// Both are replayed here on synthetic items so they can't silently return.
import { describe, it, expect } from 'vitest';
import {
  MessageType,
  TurnStatus,
  type AgentTranscription,
  type TranscriptHelperItem,
  type UserTranscription,
} from 'agora-agent-client-toolkit';
import {
  attributeRole,
  mapTranscriptItems,
  latestAgentText,
  latestUserText,
} from './transcript-mapping';

type Item = TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>;

// Build a synthetic transcript item. `object` sets metadata.object (the
// authoritative role signal); omit it to simulate the metadata-absent path.
function item(p: {
  uid: string;
  text: string;
  time: number;
  object?: MessageType;
  status?: TurnStatus;
}): Item {
  return {
    uid: p.uid,
    stream_id: 0,
    turn_id: 0,
    _time: p.time,
    text: p.text,
    status: p.status ?? TurnStatus.END,
    metadata: p.object ? ({ object: p.object } as Partial<AgentTranscription>) : null,
  };
}

const LOCAL_UID = '100000';

describe('attributeRole (C1)', () => {
  it('metadata.object=user.transcription → user (even if uid is "0")', () => {
    expect(
      attributeRole(item({ uid: '0', text: 'hi', time: 1, object: MessageType.USER_TRANSCRIPTION }), LOCAL_UID),
    ).toBe('user');
  });
  it('metadata.object=assistant.transcription → agent (even if uid is "0")', () => {
    // THE C1 BUG: old code did `uid === "0" → user`, mislabelling this agent
    // turn as the user's question. metadata.object must win.
    expect(
      attributeRole(item({ uid: '0', text: 'Barnaby was a cat', time: 1, object: MessageType.AGENT_TRANSCRIPTION }), LOCAL_UID),
    ).toBe('agent');
  });
  it('no metadata → falls back to localUid match (user)', () => {
    expect(attributeRole(item({ uid: LOCAL_UID, text: 'q', time: 1 }), LOCAL_UID)).toBe('user');
  });
  it('no metadata + non-local uid → agent', () => {
    expect(attributeRole(item({ uid: '999', text: 'a', time: 1 }), LOCAL_UID)).toBe('agent');
  });
});

describe('mapTranscriptItems — branch window (C2)', () => {
  it('no active branch → empty (narration never becomes Q&A)', () => {
    const out = mapTranscriptItems(
      [item({ uid: '0', text: 'Barnaby was a cat', time: 1000, object: MessageType.AGENT_TRANSCRIPTION })],
      { localUid: LOCAL_UID, branchStartedAt: null },
    );
    expect(out).toEqual([]);
  });

  it('drops the narration tail delivered before the branch started (THE pollution bug)', () => {
    // Reproduces the Barnaby session: two narration agent-transcripts arrive
    // BEFORE the user interrupts, then the real question. Only the question
    // (and anything after branch start) should survive.
    const branchAt = 30_000;
    const out = mapTranscriptItems(
      [
        item({ uid: '0', text: 'Barnaby was a cat who lived in the library.', time: 5_000, object: MessageType.AGENT_TRANSCRIPTION }),
        item({ uid: '0', text: 'One night he found a book of stars.', time: 18_000, object: MessageType.AGENT_TRANSCRIPTION }),
        item({ uid: LOCAL_UID, text: "What's the name of the cat?", time: 30_500, object: MessageType.USER_TRANSCRIPTION }),
      ],
      { localUid: LOCAL_UID, branchStartedAt: branchAt },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'user', text: "What's the name of the cat?" });
  });

  it('keeps an item within the 500ms grace before branch start (race window)', () => {
    const out = mapTranscriptItems(
      [item({ uid: LOCAL_UID, text: 'early Q', time: 9_700, object: MessageType.USER_TRANSCRIPTION })],
      { localUid: LOCAL_UID, branchStartedAt: 10_000 },
    );
    expect(out).toHaveLength(1);
  });

  it('drops an item just outside the grace window', () => {
    const out = mapTranscriptItems(
      [item({ uid: LOCAL_UID, text: 'too early', time: 9_400, object: MessageType.USER_TRANSCRIPTION })],
      { localUid: LOCAL_UID, branchStartedAt: 10_000 },
    );
    expect(out).toEqual([]);
  });

  it('filters IN_PROGRESS (partial) turns', () => {
    const out = mapTranscriptItems(
      [item({ uid: LOCAL_UID, text: 'partial', time: 11_000, object: MessageType.USER_TRANSCRIPTION, status: TurnStatus.IN_PROGRESS })],
      { localUid: LOCAL_UID, branchStartedAt: 10_000 },
    );
    expect(out).toEqual([]);
  });

  it('filters whitespace-only turns', () => {
    const out = mapTranscriptItems(
      [item({ uid: LOCAL_UID, text: '   ', time: 11_000, object: MessageType.USER_TRANSCRIPTION })],
      { localUid: LOCAL_UID, branchStartedAt: 10_000 },
    );
    expect(out).toEqual([]);
  });

  it('end-to-end: clean (user,agent) pair survives with correct roles', () => {
    const out = mapTranscriptItems(
      [
        item({ uid: LOCAL_UID, text: "What's the cat's name?", time: 30_100, object: MessageType.USER_TRANSCRIPTION }),
        item({ uid: '0', text: 'His name is Barnaby.', time: 31_500, object: MessageType.AGENT_TRANSCRIPTION }),
      ],
      { localUid: LOCAL_UID, branchStartedAt: 30_000 },
    );
    expect(out).toEqual([
      { role: 'user', text: "What's the cat's name?", ts: 30_100 },
      { role: 'agent', text: 'His name is Barnaby.', ts: 31_500 },
    ]);
  });

  it('respects keep (most recent N)', () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      item({ uid: LOCAL_UID, text: `q${i}`, time: 10_000 + i, object: MessageType.USER_TRANSCRIPTION }),
    );
    const out = mapTranscriptItems(items, { localUid: LOCAL_UID, branchStartedAt: 10_000, keep: 20 });
    expect(out).toHaveLength(20);
    expect(out[0].text).toBe('q5'); // first 5 dropped
    expect(out[19].text).toBe('q24');
  });
});

describe('latestAgentText (audio-synced reveal source)', () => {
  it('returns the most recent agent item text by _time', () => {
    const items = [
      item({ uid: '0', text: 'Young Albert sat', time: 100, object: MessageType.AGENT_TRANSCRIPTION, status: TurnStatus.IN_PROGRESS }),
      item({ uid: '0', text: 'Young Albert sat on a hill', time: 200, object: MessageType.AGENT_TRANSCRIPTION, status: TurnStatus.IN_PROGRESS }),
    ];
    expect(latestAgentText(items, LOCAL_UID)).toBe('Young Albert sat on a hill');
  });

  it('ignores user items (only the agent narration drives the reveal)', () => {
    const items = [
      item({ uid: '0', text: 'The fox crept out', time: 300, object: MessageType.AGENT_TRANSCRIPTION }),
      item({ uid: LOCAL_UID, text: 'why is it silver', time: 400, object: MessageType.USER_TRANSCRIPTION }),
    ];
    expect(latestAgentText(items, LOCAL_UID)).toBe('The fox crept out');
  });

  it('returns null when there is no agent text yet', () => {
    expect(latestAgentText([], LOCAL_UID)).toBeNull();
    const onlyUser = [item({ uid: LOCAL_UID, text: 'hi', time: 1, object: MessageType.USER_TRANSCRIPTION })];
    expect(latestAgentText(onlyUser, LOCAL_UID)).toBeNull();
  });

  it('skips blank agent items', () => {
    const items = [
      item({ uid: '0', text: 'real narration', time: 100, object: MessageType.AGENT_TRANSCRIPTION }),
      item({ uid: '0', text: '   ', time: 200, object: MessageType.AGENT_TRANSCRIPTION }),
    ];
    expect(latestAgentText(items, LOCAL_UID)).toBe('real narration');
  });
});

describe('latestUserText (live composer echo source)', () => {
  it('returns the most recent user item text by _time (incl. in-progress)', () => {
    const items = [
      item({ uid: LOCAL_UID, text: 'what if', time: 100, object: MessageType.USER_TRANSCRIPTION, status: TurnStatus.IN_PROGRESS }),
      item({ uid: LOCAL_UID, text: 'what if I run faster than light', time: 200, object: MessageType.USER_TRANSCRIPTION, status: TurnStatus.IN_PROGRESS }),
    ];
    expect(latestUserText(items, LOCAL_UID)).toBe('what if I run faster than light');
  });

  it('ignores agent items (only the user question echoes in the composer)', () => {
    const items = [
      item({ uid: LOCAL_UID, text: 'why is the sky blue', time: 300, object: MessageType.USER_TRANSCRIPTION }),
      item({ uid: '0', text: 'Because of scattering', time: 400, object: MessageType.AGENT_TRANSCRIPTION }),
    ];
    expect(latestUserText(items, LOCAL_UID)).toBe('why is the sky blue');
  });

  it('returns null when there is no user text yet', () => {
    expect(latestUserText([], LOCAL_UID)).toBeNull();
    const onlyAgent = [item({ uid: '0', text: 'narration', time: 1, object: MessageType.AGENT_TRANSCRIPTION })];
    expect(latestUserText(onlyAgent, LOCAL_UID)).toBeNull();
  });

  it('skips blank user items', () => {
    const items = [
      item({ uid: LOCAL_UID, text: 'real question', time: 100, object: MessageType.USER_TRANSCRIPTION }),
      item({ uid: LOCAL_UID, text: '   ', time: 200, object: MessageType.USER_TRANSCRIPTION }),
    ];
    expect(latestUserText(items, LOCAL_UID)).toBe('real question');
  });
});

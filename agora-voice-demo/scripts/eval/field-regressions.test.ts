// Field-regression corpus: bugs that were first found by casual manual testing
// or screenshots, not by the original benchmark. Keep them named like incidents
// so `pnpm test` tells us whether the suite protects real user-visible failures.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MessageType,
  TurnStatus,
  type AgentTranscription,
  type TranscriptHelperItem,
  type UserTranscription,
} from 'agora-agent-client-toolkit';
import { mapTranscriptItems } from '../../components/tutor/transcript-mapping';

type Item = TranscriptHelperItem<Partial<UserTranscription | AgentTranscription>>;

function item(p: {
  uid: string;
  text: string;
  time: number;
  object: MessageType;
  status?: TurnStatus;
}): Item {
  return {
    uid: p.uid,
    stream_id: 0,
    turn_id: 0,
    _time: p.time,
    text: p.text,
    status: p.status ?? TurnStatus.END,
    metadata: { object: p.object } as Partial<AgentTranscription>,
  };
}

describe('field regressions caught from live/manual testing', () => {
  it('2026-06-01 Render screenshot: main narration must not appear under IN ANSWER TO YOU', () => {
    const localUid = '100000';
    const narration =
      'He realized that if he moved as fast as light, the world around him would look very different.';

    const out = mapTranscriptItems(
      [
        item({
          uid: localUid,
          text: 'Hello? Can you hear me?',
          time: 10100,
          object: MessageType.USER_TRANSCRIPTION,
        }),
        item({
          uid: '0',
          text: 'He realized that if he moved as fast as light,',
          time: 10900,
          object: MessageType.AGENT_TRANSCRIPTION,
        }),
      ],
      {
        localUid,
        branchStartedAt: 10000,
        narrationTexts: [narration],
      },
    );

    expect(out).toEqual([
      { role: 'user', text: 'Hello? Can you hear me?', ts: 10100 },
    ]);
  });

  it('2026-06-01 typed QA screenshot: text-mode QA must enter the same local hush branch as voice', () => {
    const tutorPagePath = new URL('../../components/TutorPage.tsx', import.meta.url);
    const src = readFileSync(tutorPagePath, 'utf8');

    expect(src).toContain("beginVoiceBranch('typed', now, { interruptAudio: false })");
    expect(src).toContain('agentAudioTrackRef.current?.setVolume(0)');
    expect(src).toContain("seam('hush', 0)");
  });

  it('2026-06-01 typed QA screenshot: agent LLM errors must render as an answer bubble, not silent ignore', () => {
    const tutorPagePath = new URL('../../components/TutorPage.tsx', import.meta.url);
    const src = readFileSync(tutorPagePath, 'utf8');

    expect(src).toContain('QA_ERROR_FALLBACK');
    expect(src).toContain("seam('agent_error'");
    expect(src).toContain("role: 'agent' as const, text: QA_ERROR_FALLBACK");
  });

  it('2026-06-01 voice screenshot: live user transcript must also open a branch', () => {
    const tutorPagePath = new URL('../../components/TutorPage.tsx', import.meta.url);
    const src = readFileSync(tutorPagePath, 'utf8');

    expect(src).toContain("beginVoiceBranch('transcript', liveUserTurn.ts)");
    expect(src).toContain('lastLiveUserTurnRef.current');
  });
});

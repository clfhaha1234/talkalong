// Integration test for the barge-in INSTANT-PAUSE path (handle.beginBranch).
//
// The user-reported bug: when the listener started talking, the story kept
// going (subtitles still moving, TTS still playing) until the silence-confirm
// + qa-ended fired ~2.8s later — the agent talked over them. The fix routes a
// /api/tutor/branch-started ping to handle.beginBranch() the INSTANT the browser
// sees agent speaking→listening, which must (1) flip the spine MAIN→BRANCH so the
// narrator stops queuing segments, and (2) call session.interrupt() to flush the
// audio Agora has already buffered.
//
// A real voice barge-in needs live Agora + a mic and can't run in CI, so we drive
// the REAL orchestrator with a mocked AgentSession that records interrupt()/say()
// and assert the two mechanisms + that narration actually parks (the narration
// promise does not resolve while we're in BRANCH).

import { describe, it, expect, vi } from 'vitest';

const interruptCalls: number[] = [];
const sayCalls: Array<{ text: string; opts: { priority?: string } }> = [];

vi.mock('agora-agent-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('agora-agent-server-sdk')>();
  const mkStub = () => ({
    start: async () => 'fake-agent-id',
    stop: async () => {},
    say: async (text: string, opts: { priority?: string } = {}) => {
      sayCalls.push({ text, opts });
    },
    interrupt: async () => {
      interruptCalls.push(sayCalls.length);
    },
    update: async () => {},
    getHistory: async () => ({ contents: [] }),
    getTurns: async () => ({ turns: [] }),
    raw: {},
    status: 'running' as const,
    id: 'fake-agent-id',
    appId: 'app',
  });
  return {
    ...orig,
    AgoraClient: class {
      constructor(_o: unknown) {}
    },
    Agent: class {
      withStt() { return this; }
      withLlm() { return this; }
      withTts() { return this; }
      withFillerWords() { return this; }
      withTurnDetection() { return this; }
      withAdvancedFeatures() { return this; }
      withParameters() { return this; }
      createSession() { return mkStub(); }
    },
  };
});

import { startTutorSessionFromScenes } from './index';
import type { Scene } from '@/lib/lesson/types';

const scenes: Scene[] = [
  { id: 's1', chapter: 'Ch1', sceneNum: 'I', headline: ['A', 'B'], narration_text: 'Lina crept toward the humming tree, holding her breath.', image_prompt: 'x' },
  { id: 's2', chapter: 'Ch2', sceneNum: 'II', headline: ['C', 'D'], narration_text: 'The fox watched her from behind the silver leaves.', image_prompt: 'y' },
  { id: 's3', chapter: 'Ch3', sceneNum: 'III', headline: ['E', 'F'], narration_text: 'A door opened in the trunk, glowing faintly.', image_prompt: 'z' },
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollUntil(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await wait(10);
  }
}

describe('beginBranch — instant pause on barge-in', () => {
  it('flips MAIN→BRANCH and calls session.interrupt() immediately', async () => {
    interruptCalls.length = 0;
    sayCalls.length = 0;

    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });

    // Kick off narration but DON'T await — it parks in waitForMain() once we
    // branch, so the promise intentionally never resolves in this test.
    const narration = handle.startNarration().catch(() => {});

    // Wait until the narrator has actually started the main line (MAIN + at least
    // one segment pushed). enterBranch only fires from MAIN, so this guards the race.
    const started = await pollUntil(
      () => handle.progress.snapshot().outer_state === 'MAIN' && sayCalls.length >= 1,
    );
    expect(started).toBe(true);

    const interruptsBefore = interruptCalls.length;

    // === the barge-in signal ===
    handle.beginBranch();

    // (1) spine paused: the narrator's next tick sees BRANCH and stops queuing.
    expect(handle.progress.snapshot().outer_state).toBe('BRANCH');
    // (2) in-flight/buffered TTS flushed.
    expect(interruptCalls.length).toBe(interruptsBefore + 1);

    // The narrator must PARK, not finish: with 3 scenes, a non-paused narrator
    // would keep queuing toward 3 say() calls. Give it room to (wrongly) advance.
    const sayCountAtBranch = sayCalls.length;
    await wait(150);
    expect(sayCalls.length).toBe(sayCountAtBranch); // no new segments queued
    expect(handle.progress.snapshot().outer_state).toBe('BRANCH');

    await handle.stop();
    void narration; // parked in waitForMain by design — do not await
  });

  it('is idempotent and never throws (double-fire / already in BRANCH)', async () => {
    interruptCalls.length = 0;
    sayCalls.length = 0;

    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    const narration = handle.startNarration().catch(() => {});
    await pollUntil(
      () => handle.progress.snapshot().outer_state === 'MAIN' && sayCalls.length >= 1,
    );

    handle.beginBranch();
    expect(handle.progress.snapshot().outer_state).toBe('BRANCH');

    // Second fire (browser re-pings, or qa-ended races): no throw, stays BRANCH,
    // interrupt is best-effort re-issued.
    expect(() => handle.beginBranch()).not.toThrow();
    expect(handle.progress.snapshot().outer_state).toBe('BRANCH');
    expect(interruptCalls.length).toBe(2);

    await handle.stop();
    void narration; // parked in waitForMain by design — do not await
  });
});

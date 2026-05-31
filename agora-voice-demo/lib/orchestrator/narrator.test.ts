// lib/orchestrator/narrator.test.ts
//
// Narrator is mostly IO (calls session.say()). We test the queue/loop
// behaviour with a fake session that records the calls and an injected
// no-op sleep so tests don't actually wait.

import { describe, it, expect, vi } from 'vitest';
import { runNarration } from './narrator';
import { ProgressState } from './progress-state';
import type { Segment, ProgressEvent } from './types';
import type { AgentSession } from 'agora-agent-server-sdk';

function seg(id: string, text: string): Segment {
  return {
    id,
    range: { start: 0, end: text.length },
    text,
    approx_duration_ms: 1,
    category: 'exposition',
    elicitation_node: false,
  };
}

function fakeSession(): AgentSession & {
  _calls: Array<{ text: string; priority: string | undefined; interruptable: boolean | undefined }>;
} {
  const calls: Array<{ text: string; priority: string | undefined; interruptable: boolean | undefined }> = [];
  return {
    _calls: calls,
    say: vi.fn(async (text: string, fakeOpts?: { priority?: string; interruptable?: boolean }) => {
      calls.push({ text, priority: fakeOpts?.priority, interruptable: fakeOpts?.interruptable });
    }),
    interrupt: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as AgentSession & { _calls: typeof calls };
}

const noSleep = () => Promise.resolve();

describe('narrator (pointer-driven, APPEND-only)', () => {
  it('pushes every segment via APPEND in order', async () => {
    const segs = [seg('s1', 'a'), seg('s2', 'b'), seg('s3', 'c')];
    const ps = new ProgressState('sess', segs);
    const sess = fakeSession();
    await runNarration(sess, ps, { sleep: noSleep });
    expect(sess._calls.map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(sess._calls.every((c) => c.priority === 'APPEND')).toBe(true);
    // Every narration segment MUST be interruptable, or Agora treats it as a
    // non-interruptible broadcast and the user can't barge in on it by voice
    // (the root cause of the "agent talks over me / STT can't hear me" bug).
    expect(sess._calls.every((c) => c.interruptable === true)).toBe(true);
  });

  it('emits segment_started + segment_completed for each segment', async () => {
    const segs = [seg('s1', 'a'), seg('s2', 'b')];
    const ps = new ProgressState('sess', segs);
    const events: ProgressEvent[] = [];
    ps.subscribe((e) => events.push(e));
    await runNarration(fakeSession(), ps, { sleep: noSleep });
    const startedIds = events
      .filter((e): e is Extract<ProgressEvent, { type: 'segment_started' }> => e.type === 'segment_started')
      .map((e) => e.segment_id);
    const completedIds = events
      .filter((e): e is Extract<ProgressEvent, { type: 'segment_completed' }> => e.type === 'segment_completed')
      .map((e) => e.segment_id);
    expect(startedIds).toEqual(['s1', 's2']);
    expect(completedIds).toEqual(['s1', 's2']);
  });

  it('onSegmentNarrated fires after each segment with accumulating narrated-so-far (context-sync)', async () => {
    // This is the hook index.ts uses to push "story so far" into the agent's
    // LLM system context via session.update() — the robust fix for the
    // "what's the cat's name?" bug. It must (a) fire once per completed
    // segment, (b) carry ALL segments narrated so far (not just the latest),
    // so a barge-in at scene N can answer facts from scenes 1..N.
    const segs = [seg('s1', 'Barnaby the cat'), seg('s2', 'found a book'), seg('s3', 'chased stars')];
    const ps = new ProgressState('sess', segs);
    const snapshots: string[][] = [];
    await runNarration(fakeSession(), ps, {
      sleep: noSleep,
      onSegmentNarrated: (narrated) => snapshots.push(narrated.map((s) => s.id)),
    });
    expect(snapshots).toEqual([['s1'], ['s1', 's2'], ['s1', 's2', 's3']]);
  });

  it('fires narration_complete after all segments', async () => {
    const segs = [seg('s1', 'a')];
    const ps = new ProgressState('sess', segs);
    const events: ProgressEvent[] = [];
    ps.subscribe((e) => events.push(e));
    await runNarration(fakeSession(), ps, { sleep: noSleep });
    expect(events.find((e) => e.type === 'narration_complete')).toBeTruthy();
  });

  it('BRANCH preemption mid-segment: does not advance the pointer', async () => {
    // Slow per-segment sleep so we can fire BRANCH while narrator is "in" s1.
    let resolveSleep!: () => void;
    const slowSleep = vi.fn(() => new Promise<void>((r) => { resolveSleep = r; }));
    const segs = [seg('s1', 'a'), seg('s2', 'b'), seg('s3', 'c')];
    const ps = new ProgressState('sess', segs);
    const sess = fakeSession();
    const runP = runNarration(sess, ps, { sleep: slowSleep });

    // Let narrator push s1 and arm its sleep+branch race.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sess._calls.map((c) => c.text)).toEqual(['a']);

    // Fire BRANCH — should preempt the sleep without advancing pointer.
    ps.enterBranch();
    await Promise.resolve();

    // Narrator is now waiting in waitForMain. exitBranch lets it resume.
    // We rewind the pointer so it re-emits s1 (as a "restart" planner would).
    ps.setNextIndex(0);
    ps.exitBranch();

    // Drain the sleep promise so next iter's sleep can resolve.
    resolveSleep();
    // Subsequent iters use freshly-armed sleeps — auto-resolve all.
    slowSleep.mockImplementation(() => Promise.resolve());

    await runP;

    // s1 was spoken twice (preempted then restarted), s2/s3 once each.
    expect(sess._calls.map((c) => c.text)).toEqual(['a', 'a', 'b', 'c']);
  });

  it('BRANCH preemption + skip strategy: pointer advanced past paused segment', async () => {
    let resolveSleep!: () => void;
    const slowSleep = vi.fn(() => new Promise<void>((r) => { resolveSleep = r; }));
    const segs = [seg('s1', 'a'), seg('s2', 'b'), seg('s3', 'c')];
    const ps = new ProgressState('sess', segs);
    const sess = fakeSession();
    const runP = runNarration(sess, ps, { sleep: slowSleep });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    ps.enterBranch();
    await Promise.resolve();

    // Planner says skip the paused scene → advance pointer past it.
    ps.setNextIndex(1);
    ps.exitBranch();

    resolveSleep();
    slowSleep.mockImplementation(() => Promise.resolve());

    await runP;

    expect(sess._calls.map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });

  it('respects shouldCancel between iterations', async () => {
    const segs = [seg('s1', 'a'), seg('s2', 'b'), seg('s3', 'c')];
    const ps = new ProgressState('sess', segs);
    const sess = fakeSession();
    let cancelAfter = 1;
    await runNarration(sess, ps, {
      sleep: noSleep,
      shouldCancel: () => sess._calls.length >= cancelAfter,
    });
    cancelAfter = 1;
    expect(sess._calls.map((c) => c.text)).toEqual(['a']);
  });
});

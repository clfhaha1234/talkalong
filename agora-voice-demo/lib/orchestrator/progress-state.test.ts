import { describe, it, expect, vi } from 'vitest';
import { ProgressState } from './progress-state';
import type { Segment } from './types';

function fakeSegment(id: string, text = 'hello'): Segment {
  return {
    id,
    range: { start: 0, end: text.length },
    text,
    approx_duration_ms: 1000,
    category: 'exposition',
    elicitation_node: false,
  };
}

describe('ProgressState branch + comprehension', () => {
  const segs = [fakeSegment('s1'), fakeSegment('s2'), fakeSegment('s3')];

  it('enterBranch records paused segment + emits branch_started', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[1]); // currently on s2
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.enterBranch();
    expect(ps.snapshot().branch_line.active).toBe(true);
    expect(ps.snapshot().branch_line.paused_segment_id).toBe('s2');
    expect(events.find((e) => e.type === 'branch_started')).toBeTruthy();
  });

  it('exitBranch emits branch_ended and clears branch state', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[1]);
    ps.enterBranch();
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.exitBranch();
    expect(ps.snapshot().branch_line.active).toBe(false);
    expect(events.find((e) => e.type === 'branch_ended')).toBeTruthy();
  });

  it('recordQaTurn increments qa_turn_count and appends history', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[0]);
    ps.enterBranch();
    ps.recordQaTurn('user', 'why?');
    ps.recordQaTurn('agent', 'because of X');
    expect(ps.snapshot().branch_line.qa_turn_count).toBe(2);
    expect(ps.snapshot().branch_line.qa_history.length).toBe(2);
    expect(ps.snapshot().branch_line.qa_history[0].text).toBe('why?');
  });

  it('updateComprehension fires comprehension_changed event', () => {
    const ps = new ProgressState('sess1', segs);
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.updateComprehension({ depth_setting: 'deeper', elicitations_asked: 1, elicitations_correct: 1, qa_turns_total: 0, qa_followup_depth_avg: 0 });
    expect(events.find((e) => e.type === 'comprehension_changed')?.signal.depth_setting).toBe('deeper');
  });

  it('replaceSegments swaps next-N segments after rescript', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[0]);
    const newS2 = fakeSegment('s2', 'rewritten s2');
    const newS3 = fakeSegment('s3', 'rewritten s3');
    ps.replaceSegments(['s2', 's3'], [newS2, newS3]);
    // segments array updated
    expect(ps.segments.find((s) => s.id === 's2')!.text).toBe('rewritten s2');
    expect(ps.segments.find((s) => s.id === 's3')!.text).toBe('rewritten s3');
  });
});

describe('ProgressState pointer + wait primitives', () => {
  const segs = [fakeSegment('s1'), fakeSegment('s2'), fakeSegment('s3')];

  it('nextSegment() starts at index 0 and advances via advanceMain()', () => {
    const ps = new ProgressState('sess', segs);
    expect(ps.nextSegment()?.id).toBe('s1');
    ps.advanceMain();
    expect(ps.nextSegment()?.id).toBe('s2');
    ps.advanceMain();
    expect(ps.nextSegment()?.id).toBe('s3');
    ps.advanceMain();
    expect(ps.nextSegment()).toBeNull();
  });

  it('setNextIndex rewinds and clamps to [0, segments.length]', () => {
    const ps = new ProgressState('sess', segs);
    ps.advanceMain();
    ps.advanceMain();
    ps.setNextIndex(0);
    expect(ps.nextSegment()?.id).toBe('s1');
    ps.setNextIndex(99); // clamps
    expect(ps.nextSegment()).toBeNull();
    ps.setNextIndex(-5); // clamps
    expect(ps.nextSegment()?.id).toBe('s1');
  });

  it('waitForMain resolves immediately when outer is MAIN', async () => {
    const ps = new ProgressState('sess', segs);
    ps.enterMain();
    await expect(ps.waitForMain()).resolves.toBeUndefined();
  });

  it('waitForMain resolves on branch_ended event', async () => {
    const ps = new ProgressState('sess', segs);
    ps.enterMain();
    ps.startSegment(segs[0]);
    ps.enterBranch();
    const p = ps.waitForMain();
    // exit BRANCH on next tick → waitForMain should fulfill
    setTimeout(() => ps.exitBranch(), 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('waitForBranchStart fires on branch_started and can be cancelled', async () => {
    const ps = new ProgressState('sess', segs);
    ps.enterMain();
    ps.startSegment(segs[0]);
    const sig = ps.waitForBranchStart();
    let fired = false;
    sig.promise.then(() => {
      fired = true;
    });
    ps.enterBranch();
    await Promise.resolve(); // flush microtask queue
    expect(fired).toBe(true);

    // cancellation prevents the listener from firing on subsequent BRANCH
    ps.exitBranch();
    const sig2 = ps.waitForBranchStart();
    let fired2 = false;
    sig2.promise.then(() => {
      fired2 = true;
    });
    sig2.cancel();
    ps.enterBranch();
    await Promise.resolve();
    expect(fired2).toBe(false);
  });

  it('currentSegmentProgress() returns 0 with no active segment, fraction once started', async () => {
    const shortSeg: Segment = {
      id: 's1',
      range: { start: 0, end: 5 },
      text: 'hello',
      approx_duration_ms: 100,
      category: 'exposition',
      elicitation_node: false,
    };
    const ps = new ProgressState('sess', [shortSeg]);
    expect(ps.currentSegmentProgress()).toBe(0);
    ps.startSegment(shortSeg);
    // immediately after start, ~0
    expect(ps.currentSegmentProgress()).toBeLessThan(0.3);
    // after the full duration elapses, clamps to 1
    await new Promise((r) => setTimeout(r, 130));
    expect(ps.currentSegmentProgress()).toBe(1);
  });

  it('outerState() returns current outer without allocating snapshot', () => {
    const ps = new ProgressState('sess', segs);
    expect(ps.outerState()).toBe('IDLE');
    ps.enterMain();
    expect(ps.outerState()).toBe('MAIN');
    ps.startSegment(segs[0]);
    ps.enterBranch();
    expect(ps.outerState()).toBe('BRANCH');
    ps.exitBranch();
    expect(ps.outerState()).toBe('MAIN');
  });
});

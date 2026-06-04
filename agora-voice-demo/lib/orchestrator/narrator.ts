// lib/orchestrator/narrator.ts
//
// Pointer-driven narrator with real audio↔progress timing and BRANCH-aware
// preemption.
//
// Loop shape per iteration:
//   1. If outer_state === BRANCH, await waitForMain() so we don't APPEND
//      new segments on top of the Q&A's bridge + rewrite.
//   2. Pull next segment from ProgressState's pointer (not a fixed array).
//   3. session.say(seg.text, APPEND) — return resolves at queue-add time.
//   4. Race per-segment audio-drain sleep against waitForBranchStart() so a
//      user interrupt during the segment cleanly breaks out without
//      mis-completing.
//   5. On clean finish: completeSegment + advanceMain.
//   6. On BRANCH preemption: loop without advancing — handleQaEnded will
//      rewind the pointer (and/or rewrite the paused segment via
//      replaceSegments) before exitBranch() lets us resume.
//
// The per-segment sleep is approximate (chars/sec heuristic in
// approx_duration_ms). True RTM-driven sync would tie progress events to
// SPEAKING→IDLE transitions; for a children's storybook the ±1s drift is
// well within the comfort range.

import type { AgentSession } from 'agora-agent-server-sdk';
import type { ProgressState } from './progress-state';
import type { Segment } from './types';

const TAIL_DRAIN_MS = 1500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunNarrationOptions {
  /** Hook for future external cancellation. */
  shouldCancel?: () => boolean;
  /** Injected sleep for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called (fire-and-forget) when each segment starts, with the list of
   * segments started so far (in order). The orchestrator uses this to sync the
   * agent's LLM system-context to "what the listener has reached" via
   * session.update() — so a barge-in during the first seconds of a segment can
   * still answer facts from that current segment. Future segments stay out of
   * context (no spoilers). Never throws into the narration loop.
   */
  onSegmentNarrated?: (narratedSoFar: Segment[]) => void;
}

export async function runNarration(
  session: AgentSession,
  progress: ProgressState,
  opts: RunNarrationOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  // Accumulates the segments the listener has reached (in order) for
  // context-sync. Includes the current in-flight segment as soon as it starts,
  // because barge-in can happen before the segment finishes.
  const narrated: Segment[] = [];
  const syncContext = (seg: Segment): void => {
    const idx = narrated.findIndex((s) => s.id === seg.id);
    if (idx >= 0) {
      const prev = narrated[idx];
      narrated[idx] =
        prev.text === seg.text || prev.text.includes(seg.text)
          ? prev
          : { ...seg, text: `${prev.text}\n${seg.text}` };
    } else {
      narrated.push(seg);
    }
    if (opts.onSegmentNarrated) {
      try {
        opts.onSegmentNarrated([...narrated]);
      } catch {
        // never break narration on a context-sync failure
      }
    }
  };
  progress.enterMain();
  while (!opts.shouldCancel?.()) {
    if (progress.outerState() === 'BRANCH') {
      await progress.waitForMain();
      continue;
    }
    const seg = progress.nextSegment();
    if (!seg) break;

    progress.startSegment(seg);
    syncContext(seg);
    try {
      // interruptable: true is THE flag that makes barge-in feel like raw Agora
      // 1:1 chat. Without it, Agora treats a say()-injected broadcast as a
      // non-interruptible announcement: the user's voice does NOT stop it, so
      // the agent talks over them (subtitles keep moving) AND the user's audio
      // overlaps the still-playing TTS, which wrecks STT. LLM-driven turns (our
      // Q&A answers) are interruptible by default — which is exactly why 1:1
      // chat is smooth but the narration was not. With this flag, Agora's native
      // VAD stops the narration server-side the instant the listener speaks
      // (~native latency, no browser round-trip), and the resulting
      // speaking→listening transition is what then drives beginBranch() to pause
      // the narrator loop so it doesn't queue the next segment.
      await session.say(seg.text, { priority: 'APPEND', interruptable: true });
    } catch (err) {
      progress.emitError(`say() failed for ${seg.id}: ${(err as Error).message}`);
      throw err;
    }

    const branchSignal = progress.waitForBranchStart();
    const winner = await Promise.race([
      sleep(seg.approx_duration_ms).then(() => 'done' as const),
      branchSignal.promise.then(() => 'preempted' as const),
    ]);
    branchSignal.cancel();

    if (winner === 'preempted') {
      // User interrupted mid-segment. Don't complete or advance; the next
      // loop iter will see outer=BRANCH and await waitForMain. handleQaEnded
      // may rewind the pointer (planner restart strategy) or skip past this
      // segment (skip strategy) before letting us resume.
      continue;
    }
    progress.completeSegment(seg.id);
    progress.advanceMain();

  }
  // Hold the session open one final beat so the last segment's audio drains
  // out of Agora's queue before the orchestrator calls session.stop().
  await sleep(TAIL_DRAIN_MS);
  progress.finish();
}

// ProgressState — the shared object every orchestrator component reads/writes.
//
// Phase 1 surface: tracks the main_line cursor only. Phase 3 will add the
// branch_line transitions. We keep the surface stable (per PRD §5.2) so
// downstream consumers can subscribe to a single emitter.

import { EventEmitter } from 'node:events';
import type {
  Segment,
  ProgressEvent,
  ProgressSnapshot,
  MainLineState,
  BranchLineState,
  ComprehensionSignal,
} from './types';

export class ProgressState extends EventEmitter {
  readonly session_id: string;
  readonly segments: Segment[];
  private main: MainLineState;
  private branch: BranchLineState;
  private outer: ProgressSnapshot['outer_state'] = 'IDLE';
  /**
   * Pointer into `segments` for the NEXT segment the narrator should pull.
   * Separate from `main.current_segment_index` (which tracks the segment
   * CURRENTLY being spoken). Pointer-driven iteration lets handleQaEnded
   * rewind/skip mid-flight: set this to the paused index → narrator
   * re-emits the (possibly rewritten) paused segment after BRANCH exits.
   */
  private nextIndex = 0;
  /** Wall-clock ms when the current main-line segment's audio was kicked off
   *  (startSegment). Lets handleQaEnded estimate how much of the paused
   *  segment the listener actually heard before interrupting. */
  private currentSegmentStartedAt = 0;
  private comprehension: ComprehensionSignal = {
    depth_setting: 'default',
    elicitations_asked: 0,
    elicitations_correct: 0,
    qa_turns_total: 0,
    qa_followup_depth_avg: 0,
  };

  constructor(session_id: string, segments: Segment[]) {
    super();
    this.session_id = session_id;
    this.segments = segments;
    this.main = {
      current_segment_id: null,
      current_segment_index: -1,
      covered_segment_ids: [],
      remaining_segment_ids: segments.map((s) => s.id),
      inner_state: 'BETWEEN_SEGMENTS',
    };
    this.branch = {
      active: false,
      paused_segment_id: null,
      user_question: null,
      qa_turn_count: 0,
      qa_history: [],
      started_at: null,
      expected_resume_segment_id: null,
    };
  }

  snapshot(): ProgressSnapshot {
    return {
      session_id: this.session_id,
      outer_state: this.outer,
      main_line: { ...this.main, covered_segment_ids: [...this.main.covered_segment_ids], remaining_segment_ids: [...this.main.remaining_segment_ids] },
      branch_line: { ...this.branch, qa_history: [...this.branch.qa_history] },
      comprehension: { ...this.comprehension },
      updated_at: Date.now(),
      total_segments: this.segments.length,
    };
  }

  enterMain(): void {
    this.outer = 'MAIN';
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  finish(): void {
    this.outer = 'DONE';
    this.main.inner_state = 'BETWEEN_SEGMENTS';
    this.main.current_segment_id = null;
    this.main.current_segment_index = this.segments.length;
    this.emit('event', { type: 'narration_complete' } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  enterBranch(): void {
    this.outer = 'BRANCH';
    this.branch = {
      active: true,
      paused_segment_id: this.main.current_segment_id,
      user_question: null,
      qa_turn_count: 0,
      qa_history: [],
      started_at: Date.now(),
      expected_resume_segment_id: this.main.current_segment_id,
    };
    this.emit('event', { type: 'branch_started', paused_segment_id: this.branch.paused_segment_id ?? '' } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  exitBranch(): void {
    const paused = this.branch.paused_segment_id ?? '';
    this.branch = {
      active: false,
      paused_segment_id: null,
      user_question: null,
      qa_turn_count: 0,
      qa_history: [],
      started_at: null,
      expected_resume_segment_id: null,
    };
    this.outer = 'MAIN';
    this.emit('event', { type: 'branch_ended', paused_segment_id: paused } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  recordQaTurn(role: 'user' | 'agent', text: string): void {
    if (!this.branch.active) return;
    this.branch.qa_history.push({ role, text, ts: Date.now() });
    this.branch.qa_turn_count++;
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  updateComprehension(next: ComprehensionSignal): void {
    this.comprehension = { ...next };
    this.emit('event', { type: 'comprehension_changed', signal: this.comprehension } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  replaceSegments(targetIds: string[], replacements: Segment[]): void {
    if (targetIds.length !== replacements.length) {
      throw new Error('replaceSegments length mismatch');
    }
    for (let i = 0; i < targetIds.length; i++) {
      const idx = this.segments.findIndex((s) => s.id === targetIds[i]);
      if (idx >= 0) (this.segments as Segment[])[idx] = replacements[i];
    }
  }

  startSegment(segment: Segment): void {
    const idx = this.segments.findIndex((s) => s.id === segment.id);
    if (idx < 0) throw new Error(`unknown segment id: ${segment.id}`);
    this.main.current_segment_id = segment.id;
    this.main.current_segment_index = idx;
    this.main.inner_state = 'SPEAKING';
    this.currentSegmentStartedAt = Date.now();
    this.main.remaining_segment_ids = this.segments
      .slice(idx + 1)
      .map((s) => s.id);
    this.emit('event', {
      type: 'segment_started',
      segment_id: segment.id,
      segment_index: idx,
      text: segment.text,
    } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  completeSegment(segment_id: string): void {
    if (!this.main.covered_segment_ids.includes(segment_id)) {
      this.main.covered_segment_ids.push(segment_id);
    }
    this.main.inner_state = 'BETWEEN_SEGMENTS';
    this.emit('event', { type: 'segment_completed', segment_id } satisfies ProgressEvent);
    this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
  }

  emitSessionStarted(args: {
    channel: string;
    agent_id: string;
    rtc_token: string;
    rtm_token: string;
    client_uid: string;
  }): void {
    this.emit('event', {
      type: 'session_started',
      channel: args.channel,
      agent_id: args.agent_id,
      rtc_token: args.rtc_token,
      rtm_token: args.rtm_token,
      client_uid: args.client_uid,
    } satisfies ProgressEvent);
  }

  emitError(message: string): void {
    this.emit('event', { type: 'error', message } satisfies ProgressEvent);
  }

  subscribe(listener: (e: ProgressEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  // ── Pointer-driven iteration (used by narrator + handleQaEnded) ──

  /** Current outer state without allocating a snapshot. */
  outerState(): ProgressSnapshot['outer_state'] {
    return this.outer;
  }

  /**
   * Estimate how much of the current segment's audio has played, as a
   * fraction 0..1, based on wall-clock elapsed since startSegment vs the
   * segment's approx_duration_ms. Returns 0 if no segment is active.
   */
  currentSegmentProgress(): number {
    const idx = this.main.current_segment_index;
    if (idx < 0 || idx >= this.segments.length || this.currentSegmentStartedAt === 0) {
      return 0;
    }
    const dur = this.segments[idx].approx_duration_ms;
    if (dur <= 0) return 0;
    const elapsed = Date.now() - this.currentSegmentStartedAt;
    const frac = elapsed / dur;
    return frac < 0 ? 0 : frac > 1 ? 1 : frac;
  }

  /** Returns the segment the narrator should pull next, or null when done. */
  nextSegment(): Segment | null {
    if (this.nextIndex < 0 || this.nextIndex >= this.segments.length) {
      return null;
    }
    return this.segments[this.nextIndex];
  }

  /** Advance the narrator's pull pointer by one. Called after each spoken segment. */
  advanceMain(): void {
    this.nextIndex++;
  }

  /**
   * Force the next-pull pointer to a specific index. Used by handleQaEnded's
   * resume planner: if the planner decides to restart the paused scene, it
   * rewinds the pointer back to the paused index so the narrator re-speaks
   * the (potentially rewritten) segment.
   */
  setNextIndex(idx: number): void {
    this.nextIndex = Math.max(0, Math.min(idx, this.segments.length));
  }

  /**
   * Promise that resolves the next time outer_state transitions to MAIN.
   * If we're already MAIN, resolves immediately. Narrator awaits this at
   * the top of each loop iter so it pauses cleanly during BRANCH.
   */
  waitForMain(): Promise<void> {
    if (this.outer === 'MAIN') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const handler = (e: ProgressEvent) => {
        // branch_ended is the only event that flips outer BRANCH → MAIN.
        if (e.type === 'branch_ended') {
          this.off('event', handler);
          resolve();
        }
      };
      this.on('event', handler);
    });
  }

  /**
   * Cancellable promise that fires when the next branch_started event arrives.
   * Narrator races this against per-segment audio-drain sleep so it can break
   * out of the sleep cleanly if the user interrupts mid-segment.
   */
  waitForBranchStart(): { promise: Promise<void>; cancel: () => void } {
    let resolveFn: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    const handler = (e: ProgressEvent) => {
      if (e.type === 'branch_started') {
        this.off('event', handler);
        resolveFn();
      }
    };
    this.on('event', handler);
    return {
      promise,
      cancel: () => this.off('event', handler),
    };
  }
}

// lib/orchestrator/comprehension-tracker.ts
//
// Demo-grade comprehension signal. Tracks elicitation hit-rate and Q&A
// follow-up depth. Flips depth_setting at most once per session for
// stability — Phase 5+ can lift this cap once the signal is empirically
// well-calibrated.

import type { ComprehensionSignal } from './types';

export class ComprehensionTracker {
  private elicitations_asked = 0;
  private elicitations_correct = 0;
  private qa_turns_total = 0;
  private depth: ComprehensionSignal['depth_setting'] = 'default';
  private flipped = false;

  onElicitation(correct: boolean): void {
    this.elicitations_asked++;
    if (correct) this.elicitations_correct++;
    this.recompute();
  }

  onQaTurn(): void {
    this.qa_turns_total++;
    this.recompute();
  }

  signal(): ComprehensionSignal {
    return {
      depth_setting: this.depth,
      elicitations_asked: this.elicitations_asked,
      elicitations_correct: this.elicitations_correct,
      qa_turns_total: this.qa_turns_total,
      qa_followup_depth_avg: 0, // placeholder for future enrichment
    };
  }

  private recompute(): void {
    if (this.flipped) return;
    const correctRate = this.elicitations_asked > 0
      ? this.elicitations_correct / this.elicitations_asked
      : 0;
    if (this.elicitations_asked >= 3 && correctRate >= 0.8) {
      this.depth = 'deeper';
      this.flipped = true;
      return;
    }
    if (this.elicitations_asked >= 3 && correctRate <= 0.34) {
      this.depth = 'simpler';
      this.flipped = true;
      return;
    }
    if (this.qa_turns_total >= 5) {
      this.depth = 'simpler';
      this.flipped = true;
    }
  }
}

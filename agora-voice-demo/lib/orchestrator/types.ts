// Shared types for the orchestrator.

export type SegmentCategory =
  | 'exposition'
  | 'question_bearing'
  | 'numbers_symbols'
  | 'quoted_speech'
  | 'long_compound'
  | 'unknown';

export interface Segment {
  /** Stable id within a session, sequential. */
  id: string;
  /** Position in the parent text (start index, end index). */
  range: { start: number; end: number };
  /** The text to read aloud. */
  text: string;
  /** Best-guess approx duration at ~14 chars/second (English TTS heuristic). */
  approx_duration_ms: number;
  /** Category tag from the structuring layer; influences future pacing. */
  category: SegmentCategory;
  /** Marks a pre-planted elicitation node (Phase 5 will use this). */
  elicitation_node: boolean;
}

export type OrchestratorOuterState = 'IDLE' | 'MAIN' | 'BRANCH' | 'DONE';
export type InnerNarrationState = 'SPEAKING' | 'BETWEEN_SEGMENTS' | 'WAITING_FOR_AUDIO';

export interface MainLineState {
  current_segment_id: string | null;
  current_segment_index: number;
  covered_segment_ids: string[];
  remaining_segment_ids: string[];
  inner_state: InnerNarrationState;
}

export interface BranchLineState {
  active: boolean;
  paused_segment_id: string | null;
  user_question: string | null;
  qa_turn_count: number;
  qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
  started_at: number | null;
  expected_resume_segment_id: string | null;
}

export interface ComprehensionSignal {
  depth_setting: 'simpler' | 'default' | 'deeper';
  elicitations_asked: number;
  elicitations_correct: number;
  qa_turns_total: number;
  qa_followup_depth_avg: number;
}

export interface ProgressSnapshot {
  session_id: string;
  outer_state: OrchestratorOuterState;
  main_line: MainLineState;
  branch_line: BranchLineState;
  comprehension: ComprehensionSignal;
  /** Updated whenever the snapshot is read; convenience for SSE clients. */
  updated_at: number;
  /** Total number of segments in the lesson plan. */
  total_segments: number;
}

export type ProgressEvent =
  | { type: 'snapshot'; snapshot: ProgressSnapshot }
  | { type: 'segment_started'; segment_id: string; segment_index: number; text: string }
  | { type: 'segment_completed'; segment_id: string }
  | { type: 'branch_started'; paused_segment_id: string }
  | { type: 'branch_ended'; paused_segment_id: string }
  | { type: 'bridge_started'; text: string }
  | { type: 'bridge_completed' }
  | { type: 'comprehension_changed'; signal: ComprehensionSignal }
  | { type: 'narration_complete' }
  | { type: 'error'; message: string }
  | {
      type: 'active_scene_changed';
      scene_id: string;
      reason: 'planner_restart' | 'planner_skip' | 'planner_continue';
    }
  | { type: 'session_started'; channel: string; agent_id: string; rtc_token: string; rtm_token: string; client_uid: string };

// Storybook UI theme tokens, ported verbatim from
// reference/storybook-prototype/prototype-shared.jsx. The palette name `T` is
// preserved so the screen ports remain a 1:1 visual translation. We rely on
// Next.js `next/font/google` (configured in app/layout.tsx) to expose two CSS
// variables — `--font-eb-garamond` and `--font-jetbrains-mono` — so the
// strings below stay valid even when the user has no internet.

export const T = {
  paper: '#F6EFE0',
  paperEdge: '#EFE6D2',
  paperHi: '#FCF7E8',
  ink: '#3B2A1A',
  inkSoft: '#6B5742',
  inkWhisper: '#998873',
  rose: '#C77B6A',
  sage: '#8B9D7E',
  gold: '#C49A4B',
  paperTexture:
    'radial-gradient(ellipse at center, transparent 40%, rgba(60,40,20,0.06) 100%)',
} as const;

// Font stacks. The first entry pulls from the Next.js font CSS variables when
// they are loaded; the rest are graceful fallbacks for SSR/no-JS/snapshot
// scenarios. JetBrains Mono is used as the "scientific marginalia" face.
export const F_HEAD =
  'var(--font-eb-garamond), "EB Garamond", "Cormorant Garamond", serif';
export const F_BODY = 'var(--font-eb-garamond), "EB Garamond", serif';
export const F_MONO =
  'var(--font-jetbrains-mono), "JetBrains Mono", ui-monospace, monospace';

// Word-by-word reveal helper. Mirrors the prototype's tokenize: split on
// whitespace, keeping the separators. Each pair of adjacent tokens is
// (word, whitespace) — the StoryScreen advances 2 tokens per word.
export function tokenize(text: string): string[] {
  return text.split(/(\s+)/);
}

// ──────────────────────────────────────────────────────────────
// SSE event shape — emitted by /api/lesson/start. Mirrors the route's
// emitted shapes; keep in sync if the server contract changes.

export interface Scene {
  id: string;
  chapter: string;
  sceneNum: string;
  headline: [string, string];
  narration_text: string;
  image_prompt: string;
  image_url?: string;
  video_url?: string;
}

export interface ProgressSnapshot {
  session_id: string;
  outer_state: 'IDLE' | 'MAIN' | 'BRANCH' | 'DONE' | 'ERROR';
  main_line: {
    current_segment_id: string | null;
    current_segment_index: number;
    covered_segment_ids: string[];
    remaining_segment_ids: string[];
    inner_state: string;
  };
  branch_line: {
    active: boolean;
    paused_segment_id: string | null;
    user_question: string | null;
    qa_turn_count: number;
    qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
    started_at: number | null;
    expected_resume_segment_id: string | null;
  };
  comprehension: {
    depth_setting: 'simpler' | 'default' | 'deeper';
    elicitations_asked: number;
    elicitations_correct: number;
    qa_turns_total: number;
    qa_followup_depth_avg: number;
  };
  total_segments: number;
  updated_at: number;
}

export type ServerEvent =
  | { type: 'script_drafted'; title: string }
  | { type: 'scenes_composed'; scenes: Scene[] }
  | {
      type: 'image_ready';
      scene_id: string;
      image_url: string;
      cached: boolean;
      latency_ms: number;
    }
  | { type: 'image_failed'; scene_id: string; error: string }
  | { type: 'all_images_ready' }
  | { type: 'video_ready'; scene_id: string; video_url: string; cached: boolean; latency_ms: number }
  | { type: 'video_failed'; scene_id: string; error: string }
  | { type: 'all_videos_ready' }
  | {
      type: 'session_started';
      channel: string;
      agent_id: string;
      rtc_token: string;
      rtm_token: string;
      client_uid: string;
    }
  | { type: 'snapshot'; snapshot: ProgressSnapshot }
  | {
      type: 'segment_started';
      segment_id: string;
      segment_index: number;
      text: string;
    }
  | { type: 'segment_completed'; segment_id: string }
  | { type: 'narration_complete' }
  | { type: 'branch_started'; paused_segment_id: string }
  | { type: 'branch_ended'; paused_segment_id: string }
  | { type: 'bridge_started'; text: string }
  | { type: 'bridge_completed' }
  | {
      type: 'comprehension_changed';
      signal: {
        depth_setting: 'simpler' | 'default' | 'deeper';
        elicitations_asked: number;
        elicitations_correct: number;
        qa_turns_total: number;
        qa_followup_depth_avg: number;
      };
    }
  | {
      type: 'active_scene_changed';
      scene_id: string;
      reason: 'planner_restart' | 'planner_skip' | 'planner_continue';
    }
  | { type: 'error'; message: string };

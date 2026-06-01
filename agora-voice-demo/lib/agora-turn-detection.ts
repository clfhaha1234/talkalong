// Single source of truth for the Agora agent's turn-detection (barge-in /
// end-of-speech) config, shared by BOTH agent-start paths:
//   - app/api/invite-agent/route.ts  (the `/` 1:1 demo)
//   - lib/orchestrator/index.ts       (the /tutor storybook)
//
// WHY THIS FILE EXISTS: these two paths used to hardcode the same VAD block
// independently, and the /tutor copy silently drifted (bare vad SoS +
// `semantic` EoS, no prefix_padding) — which made /tutor's STT laggy + clip
// speech starts while `/` stayed buttery-smooth (the 2026-05-30 divergence).
// One exported constant means the two paths CANNOT drift again; the
// stt-config.test.ts regression guard pins the values the orchestrator emits.
//
// Deterministic VAD end-of-speech (NOT semantic, which runs an LLM → lag),
// with 300ms prefix capture so the first phoneme isn't dropped.

import type { TurnDetectionConfig } from 'agora-agent-server-sdk';

export const BASELINE_TURN_DETECTION: TurnDetectionConfig = {
  config: {
    speech_threshold: 0.5,
    start_of_speech: {
      mode: 'vad',
      vad_config: {
        interrupt_duration_ms: 160, // ms of speech before an interruption fires
        prefix_padding_ms: 300, // audio captured BEFORE speech is detected
      },
    },
    end_of_speech: {
      mode: 'vad',
      vad_config: {
        // ms of silence before the turn is considered OVER. 480 was too eager:
        // a natural mid-sentence pause ("…what's the [beat] story going to be?")
        // ended the turn early, so STT finalized half the sentence, the agent
        // auto-replied, then the rest came as a SECOND turn + SECOND reply — one
        // spoken question rendered as two bubbles + two answers (live-found
        // 2026-05-31). 800ms tolerates a thinking-pause. NOTE: this is the
        // END-of-turn timer only; barge-in ONSET is interrupt_duration_ms (160ms
        // above), so interrupting stays just as snappy.
        silence_duration_ms: 800,
      },
    },
  },
};

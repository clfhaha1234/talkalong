// Arm 3: system-prompt swap via session.update().
//
// Instead of pushing text via /speak, we rewrite the system prompt to
// "Say this verbatim: <segment>" and rely on the LLM to produce that on its
// next speaking turn. To trigger the LLM, we send a chat message that asks
// it to read the segment.
//
// This previews v0.1 PRD's Option B. We expect LLM drift to bite C3.

import {
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';

export const NAME = 'arm3_update_prompt';

const INITIAL_SYSTEM_PROMPT = `You are Ada, a voice narrator. Read the provided text aloud verbatim, without paraphrasing or summarizing. After reading, stop and wait.`;

const GREETING = ``;

export function buildAgent(): Agent {
  return new Agent({
    name: `e1-arm3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    instructions: INITIAL_SYSTEM_PROMPT,
    greeting: GREETING,
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 4 }))
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: 'English_captivating_female1',
      }),
    );
}

export const driveStrategy = 'update-then-speak' as const;

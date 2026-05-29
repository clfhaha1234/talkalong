// Arm: baseline — native Agora LLM-driven mode.
//
// This is the strawman. The agent is configured exactly like the production
// invite-agent route. Narration is whatever the LLM decides to say in response
// to a "say this" prompt nudge — we do NOT use session.say(), so the LLM's own
// turn-taking governs everything. We expect this arm to fail C3 (correctness)
// since the LLM paraphrases rather than reading verbatim.

import {
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';

export const NAME = 'baseline_native_llm';

const SYSTEM_PROMPT = `You are Ada, a voice tutor. When the user asks you to "narrate" or "read" a passage, do your best to read it back to them, but feel free to paraphrase for flow.`;

const GREETING = `Ready.`;

export function buildAgent(): Agent {
  return new Agent({
    name: `e1-baseline-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    instructions: SYSTEM_PROMPT,
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

/**
 * Baseline's "drive" function is to push a chat-style instruction via the
 * raw API, so the LLM has *something* to react to without a real user
 * microphone. We use session.raw.chatAgents() if available, otherwise we
 * fall back to skipping the cycle's narration phase entirely (the LLM
 * cannot speak without a user turn; that IS the baseline behavior).
 *
 * In practice the chat-injection path is the closest analog to "user says:
 * read this paragraph" without a real mic.
 */
export const driveStrategy = 'llm-via-prompt' as const;

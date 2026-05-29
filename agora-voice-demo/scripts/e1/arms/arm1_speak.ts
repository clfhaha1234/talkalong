// Arm 1: text-injection via session.say() + session.interrupt().
//
// The orchestrator pushes the segment text directly to TTS via the
// /agents/{id}/speak REST endpoint (priority: INTERRUPT). Mid-utterance
// interrupt uses /agents/{id}/interrupt. The LLM is configured but never
// drives narration — this arm bypasses it entirely.

import {
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';

export const NAME = 'arm1_speak_inject';

const SYSTEM_PROMPT = `You are a silent narrator. Do not initiate speech. Only respond if explicitly asked a question.`;

const GREETING = ``;

export function buildAgent(): Agent {
  return new Agent({
    name: `e1-arm1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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

export const driveStrategy = 'speak-api' as const;

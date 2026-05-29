// Arm 2: Gemini-as-brain via the SDK's built-in Gemini LLM vendor.
//
// We swap the Agora-resold OpenAI for Gemini 2.5 Flash. Same pipeline shape
// (DeepgramSTT -> Gemini LLM -> MiniMax TTS), same trigger surface
// (session.say() to push narration). Difference from Arm 1 is *which LLM
// is configured*; for narration this should be invisible (we bypass LLM
// with say()) but it matters for Q&A (E2) and for whether the LLM
// "wants to speak" on its own.
//
// Trigger note: with greeting='' and silent-narrator system prompt, the
// agent should not speak on its own, matching Arm 1's posture.

import {
  Agent,
  DeepgramSTT,
  Gemini,
  MiniMaxTTS,
} from 'agora-agent-server-sdk';

import { env } from '../lib/env.js';

export const NAME = 'arm2_gemini_brain';

const SYSTEM_PROMPT = `You are a silent narrator. Do not initiate speech. Only respond if explicitly asked a question.`;

const GREETING = ``;

export function buildAgent(): Agent {
  if (!env.geminiApiKey) {
    throw new Error('GOOGLE_API_KEY env var is required for Arm 2 (Gemini).');
  }
  return new Agent({
    name: `e1-arm2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    instructions: SYSTEM_PROMPT,
    greeting: GREETING,
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(
      new Gemini({
        apiKey: env.geminiApiKey,
        model: env.geminiModel,
        maxHistory: 4,
        // CRITICAL — discovered in E1.5: without reasoning_effort='minimal',
        // gemini-3-flash-preview and gemini-3.5-flash default to thinking mode
        // and burn the response-token budget on internal reasoning BEFORE
        // emitting visible text. TTFT 2.3-2.5s, output truncated at
        // finish_reason='length'. With 'minimal' TTFT drops to ~0.8-1.0s and
        // output is complete. gemini-3.1-flash-lite is unaffected (no thinking).
        params: { reasoning_effort: 'minimal' },
      }),
    )
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: 'English_captivating_female1',
      }),
    );
}

export const driveStrategy = 'speak-api' as const;

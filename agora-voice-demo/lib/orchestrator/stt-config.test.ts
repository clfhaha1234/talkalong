// Regression guard for the 2026-05-31 STT divergence: the tutor orchestrator's
// agent config had silently drifted away from the proven base /api/invite-agent
// config (the `/` demo whose STT is smooth), which made /tutor's STT laggy +
// garbled. This test captures the config the orchestrator actually sends to
// Agora and pins the STT-critical knobs to the base demo's values, so the
// divergence can't silently return.
//
// Base reference (app/api/invite-agent/route.ts):
//   STT:  DeepgramSTT({ model: 'nova-3', language: 'en' })
//   turn_detection: speech_threshold 0.5; start_of_speech vad
//     { interrupt_duration_ms: 160, prefix_padding_ms: 300 };
//     end_of_speech VAD { silence_duration_ms: 800 }  (was 480 — too eager)
//   session.remoteUids: [requester_id]   (NOT ['*'])

import { describe, it, expect, vi } from 'vitest';

interface Captured {
  stt?: { model?: string; language?: string };
  llm?: {
    apiKey?: string;
    model?: string;
    url?: string;
    maxHistory?: number;
    params?: Record<string, unknown>;
  };
  turn?: {
    config?: {
      speech_threshold?: number;
      start_of_speech?: { mode?: string; vad_config?: { prefix_padding_ms?: number; interrupt_duration_ms?: number } };
      end_of_speech?: { mode?: string; vad_config?: { silence_duration_ms?: number } };
    };
  };
  session?: { remoteUids?: string[] };
  filler?: { enable?: boolean };
}
const cap: Captured = {};

vi.mock('agora-agent-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('agora-agent-server-sdk')>();
  return {
    ...orig,
    AgoraClient: class {
      constructor(_o: unknown) {}
    },
    DeepgramSTT: class {
      constructor(o: { model?: string; language?: string }) {
        cap.stt = o;
      }
    },
    MiniMaxTTS: class {
      constructor(_o: unknown) {}
    },
    OpenAI: class {
      constructor(o: Captured['llm']) {
        cap.llm = o;
      }
    },
    Agent: class {
      constructor(_o: unknown) {}
      withStt() { return this; }
      withLlm() { return this; }
      withTts() { return this; }
      withFillerWords(c: Captured['filler']) { cap.filler = c; return this; }
      withTurnDetection(c: Captured['turn']) { cap.turn = c; return this; }
      withAdvancedFeatures() { return this; }
      withParameters() { return this; }
      createSession(_client: unknown, opts: { remoteUids?: string[] }) {
        cap.session = opts;
        return {
          start: async () => 'fake-agent-id',
          stop: async () => {},
          say: async () => {},
          interrupt: async () => {},
          update: async () => {},
          getHistory: async () => ({ contents: [] }),
          getTurns: async () => ({ turns: [] }),
          raw: {},
          status: 'running' as const,
          id: 'fake-agent-id',
          appId: 'app',
        };
      }
    },
  };
});

import { startTutorSessionFromScenes } from './index';
import type { Scene } from '@/lib/lesson/types';

const scenes: Scene[] = [
  { id: 's1', chapter: 'Ch1', sceneNum: 'I', headline: ['A', 'B'], narration_text: 'Hello there, this is a test scene.', image_prompt: 'x' },
];

describe('tutor agent STT config is aligned to the base / demo (anti-divergence)', () => {
  it('captures a config matching invite-agent on every STT-critical knob', async () => {
    await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b', client_uid: '100000' },
    });

    // STT: nova-3 / 'en' (NOT 'en-US')
    expect(cap.stt?.model).toBe('nova-3');
    expect(cap.stt?.language).toBe('en');

    // LLM: Gemini endpoint (NOT Agora's OpenAI reseller / api.openai.com).
    // The SDK's Gemini vendor 404s in this agent path today, so the OpenAI
    // wrapper is used only as the schema adapter for Gemini's compatible API.
    expect(cap.llm).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      model: 'gemini-3.1-flash-lite',
      maxHistory: 6,
    });
    expect(cap.llm?.url).not.toContain('api.openai.com');

    // turn_detection: deterministic VAD end-of-speech (NOT 'semantic', which was
    // laggy), with prefix_padding so speech starts aren't clipped.
    expect(cap.turn?.config?.end_of_speech?.mode).toBe('vad');
    expect(cap.turn?.config?.start_of_speech?.mode).toBe('vad');
    expect(cap.turn?.config?.start_of_speech?.vad_config?.prefix_padding_ms).toBe(300);
    expect(cap.turn?.config?.speech_threshold).toBe(0.5);
    // End-of-turn silence pinned at 800ms: tolerates a mid-sentence pause so one
    // spoken question isn't split into two turns + two answers (2026-05-31).
    // 480 (the old value) was too eager. Don't drop it back below ~700.
    expect(cap.turn?.config?.end_of_speech?.vad_config?.silence_duration_ms).toBe(800);

    // remoteUids scoped to the listener — NOT ['*'], which fed the agent's own
    // narration TTS back into STT (garbled recognition + false barge-ins).
    expect(cap.session?.remoteUids).toEqual(['100000']);
    expect(cap.session?.remoteUids).not.toContain('*');
  });

  // Filler words are DISABLED (2026-06-01). With fixed_time @ 800ms they fired on
  // nearly every barge-in answer (gpt-4o-mini's first token routinely >800ms) and
  // the engine glued the phrase onto the answer ("Let me see.I am…") or surfaced
  // it as its own transcript turn — degenerate "Hmm." / "One sec." QA bubbles
  // (live-found on the Vercel deploy). Pin enable=false so they can't silently
  // return without also revisiting the transcript-side filtering.
  it('ships filler words DISABLED (no degenerate Hmm./One sec. QA bubbles)', async () => {
    await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b', client_uid: '100000' },
    });
    expect(cap.filler?.enable).toBe(false);
  });
});

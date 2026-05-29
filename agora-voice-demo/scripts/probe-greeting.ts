// Probe: capture the agent's actual spoken sequence by running a real
// lesson session and reading session.getHistory() before stop().
//
// Tests three arms: baseline, arm A (empty greeting + storybook persona),
// arm B (in-character first-line greeting + storybook persona).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeLesson } from '../lib/lesson/scene-composer.js';
import {
  Agent,
  AgoraClient,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
  type FillerWordsConfig,
  type TurnDetectionConfig,
  type AdvancedFeatures,
  type SessionParams,
} from 'agora-agent-server-sdk';
import { env } from './e1/lib/env.js';

const INPUT_TEXT = `Tell me the story of Einstein's special relativity — how he figured out that time can stretch and bend. Aim it at a curious 10-year-old.`;
const TRIALS_PER_ARM = 3;

const PHASE3_FILLER: FillerWordsConfig = {
  enable: true,
  trigger: { mode: 'fixed_time', fixed_time_config: { response_wait_ms: 800 } },
  content: { mode: 'static', static_config: { phrases: ['Hmm.', 'Let me see.', 'One sec.'], selection_rule: 'shuffle' } },
};
const PHASE3_TURN: TurnDetectionConfig = {
  config: { start_of_speech: { mode: 'vad' }, end_of_speech: { mode: 'semantic' } },
};
const PHASE3_ADVANCED: AdvancedFeatures = { enable_rtm: true };
const PHASE3_PARAMS: SessionParams = { data_channel: 'rtm', enable_metrics: true, enable_error_message: true };

const BASELINE_PERSONA = `You are Ada, a warm and sharp voice tutor. The user has loaded a piece of content and asked you to read it aloud. When the user interrupts to ask a question, answer in 1-2 sentences and stop. Do not paraphrase the content unless asked.`;
const BASELINE_GREETING = `Got it — let me read this through for you.`;

const STORYBOOK_PERSONA = `You are the warm voice of a storybook narrator reading aloud to a curious child. Stay in character at all times — you ARE the story's voice, not an assistant. When the listener interrupts with a question, answer in 1-2 short sentences as a teacher would, then stop. Never preface or comment on your reading. Never say things like "okay", "let me", "I'll", "sure", or "let's continue" — just continue the story. No bullet points, no narration of your own actions.`;

interface Arm {
  id: string;
  persona: string;
  greeting: (first_scene_text: string) => string;
}

const ARMS: Arm[] = [
  { id: 'baseline', persona: BASELINE_PERSONA, greeting: () => BASELINE_GREETING },
  { id: 'arm_a_empty', persona: STORYBOOK_PERSONA, greeting: () => '' },
  { id: 'arm_b_inline', persona: STORYBOOK_PERSONA, greeting: (s) => s.split(/\s+/).slice(0, 8).join(' ') },
];

interface Trial {
  arm_id: string;
  trial_index: number;
  /** Sequence of turn.start.type values in chronological order. */
  turn_type_sequence: string[];
  /** First turn's type — the THING we actually care about. */
  first_turn_type: string | null;
  /** True if first turn was 'api_speak' (scene 1) and not 'greeting'. */
  first_is_scene1_not_greeting: boolean | null;
  /** First turn's playback_duration_ms (only set when end.type='ok'; missing means interrupted). */
  first_turn_playback_ms: number | null;
  greeting_turn_count: number;
  api_speak_turn_count: number;
  error?: string;
}

async function runOneTrial(arm: Arm, trial_index: number): Promise<Trial> {
  console.log(`  [arm=${arm.id} trial=${trial_index}] starting…`);
  const lesson = composeLesson(INPUT_TEXT);
  const scene1 = lesson.scenes[0]?.narration_text ?? '';
  const greeting = arm.greeting(scene1);
  const persona = arm.persona;

  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });

  const agent = new Agent({
    name: `probe-greeting-${arm.id}-${Date.now()}`,
    instructions: persona,
    greeting,
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: 'English_captivating_female1' }))
    .withFillerWords(PHASE3_FILLER)
    .withTurnDetection(PHASE3_TURN)
    .withAdvancedFeatures(PHASE3_ADVANCED)
    .withParameters(PHASE3_PARAMS);

  const channel = `probe-${arm.id}-${trial_index}-${Date.now()}`;
  const session = agent.createSession(client, {
    channel,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(3),
    debug: false,
  });

  try {
    await session.start();
    // Give Agora a beat to start the greeting before we APPEND segments.
    // The real prod path takes ~1-3s between session.start() resolving and
    // the first narrator say() due to SSE round-trip, browser subscribe,
    // and event loop. Simulate that here.
    await new Promise<void>((r) => setTimeout(r, 3000));
    // Push all scene narration_texts via APPEND like the real narrator does
    for (const scene of lesson.scenes) {
      await session.say(scene.narration_text, { priority: 'APPEND' });
    }
    // Wait for the queue to drain. Sum scene durations × 1.2 padding.
    const totalDurationMs = lesson.scenes.reduce(
      (acc, s) => acc + Math.max(700, Math.round((s.narration_text.length / 17) * 1000)) + 150,
      0,
    );
    await new Promise<void>((r) => setTimeout(r, Math.round(totalDurationMs * 1.2)));

    await session.stop();

    // getTurns() works post-stop (~1s propagation) and reports turn.start.type:
    //   'greeting' | 'api_speak' | 'voice_input' | 'silence_timeout'
    let turns: NonNullable<Awaited<ReturnType<typeof session.getTurns>>['turns']> = [];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const t = await session.getTurns();
        if (t.turns && t.turns.length > 0) {
          turns = t.turns;
          break;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const sortedTurns = [...turns].sort(
      (a, b) => (a.start?.start_at ?? 0) - (b.start?.start_at ?? 0),
    );
    const turn_type_sequence = sortedTurns.map((t) => t.start?.type ?? 'unknown');
    const first_turn_type = turn_type_sequence[0] ?? null;
    const greeting_turn_count = turn_type_sequence.filter((s) => s === 'greeting').length;
    const api_speak_turn_count = turn_type_sequence.filter((s) => s === 'api_speak').length;
    const first_turn_playback_ms = sortedTurns[0]?.end?.metadata?.playback_duration_ms ?? null;

    return {
      arm_id: arm.id,
      trial_index,
      turn_type_sequence,
      first_turn_type,
      first_is_scene1_not_greeting: first_turn_type === 'api_speak',
      first_turn_playback_ms,
      greeting_turn_count,
      api_speak_turn_count,
    };
  } catch (err) {
    try { await session.stop(); } catch {}
    return {
      arm_id: arm.id,
      trial_index,
      turn_type_sequence: [],
      first_turn_type: null,
      first_is_scene1_not_greeting: null,
      first_turn_playback_ms: null,
      greeting_turn_count: 0,
      api_speak_turn_count: 0,
      error: (err as Error).message,
    };
  }
}

async function main() {
  const results: Trial[] = [];
  for (const arm of ARMS) {
    for (let i = 0; i < TRIALS_PER_ARM; i++) {
      const r = await runOneTrial(arm, i);
      results.push(r);
      console.log(
        `    → first_turn=${r.first_turn_type} greetings=${r.greeting_turn_count} api_speaks=${r.api_speak_turn_count} first_playback=${r.first_turn_playback_ms}ms ${r.first_is_scene1_not_greeting ? '✓ no preface' : '✗ greeting played'}\n        sequence: [${r.turn_type_sequence.join(', ')}]`,
      );
    }
  }

  // Resolve subproject root relative to this script: scripts/probe-greeting.ts -> ..
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(repoRoot, 'docs/experiments/2026-05-28-greeting-debug/data');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'trials.json'), JSON.stringify(results, null, 2));

  console.log('\n=== SUMMARY ===');
  for (const arm of ARMS) {
    const trials = results.filter((r) => r.arm_id === arm.id);
    const wins = trials.filter((r) => r.first_is_scene1_not_greeting).length;
    console.log(`  ${arm.id}: ${wins}/${trials.length} skip greeting (first turn is api_speak, not greeting)`);
    console.log(`    sample turn sequence: [${trials[0]?.turn_type_sequence.join(', ')}]`);
  }
  console.log(`\nWrote ${results.length} trial records to ${outDir}/trials.json`);
}

main().catch((e) => { console.error('probe fatal:', e); process.exit(1); });

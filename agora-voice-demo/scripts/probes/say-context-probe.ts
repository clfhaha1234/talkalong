// C6 PROBE — does narrator session.say() feed the voice AI's LLM context?
//
// This settles the root cause of the "what's the cat's name?" bug (the agent
// answered "we haven't learned that yet" even though scene 1 said "Barnaby").
// Two competing explanations:
//   (a) say() text never reaches the agent's LLM history → agent is blind to
//       its own narration → B2 (static storybook injection into the persona)
//       is the correct fix.
//   (b) say() DOES feed history, but maxHistory:6 evicted scene 1 by the time
//       the user asked → the fix would be raising maxHistory, not injecting.
//
// We run two arms against a REAL Agora session and read session.getHistory():
//   control — base persona, no storybook injection. say() the cat scenes.
//             If "Barnaby" appears in getHistory → say() feeds context (b).
//             If absent → say() does NOT feed context (a).
//   b2      — personaWithStorybook(EN, catScenes) as the system prompt (the
//             real prod persona-builder). "Barnaby" MUST appear in the system
//             context → proves B2 puts the fact where the agent can see it.
//
// Cost: 2 short real Agora sessions (~1 min each). Run on demand:
//   pnpm tsx scripts/probes/say-context-probe.ts
//
// Output: prints a verdict + writes raw history to
//   docs/experiments/2026-05-30-say-context/data/probe.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { env } from '../e1/lib/env.js';
import {
  personaForLanguage,
  personaWithStorybook,
  DEFAULT_LANGUAGE,
  STORYTELLER_VOICE_ID,
} from '../../lib/language-config.js';

// The exact cat scenes from the bug-report session (Barnaby the library cat).
const CAT_SCENES = [
  { id: 's1', narration_text: 'Barnaby was a cat who lived entirely in the shadows of the old library. While the town slept, he walked across the high wooden shelves, his paws making no sound at all.' },
  { id: 's2', narration_text: 'One night, he found a book left open on a reading desk. It was filled with drawings of stars and distant planets that seemed to glow in the dim light.' },
  { id: 's3', narration_text: 'He began to chase the paper stars as they drifted off the pages and danced through the moonlit air of the great reading room.' },
];

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

interface ArmResult {
  arm: string;
  persona_contains_barnaby: boolean; // is Barnaby in the SYSTEM prompt we set?
  history_contains_barnaby: boolean; // is Barnaby anywhere in getHistory()?
  history_raw: unknown;
  error?: string;
}

async function runArm(arm: 'control' | 'b2'): Promise<ArmResult> {
  const persona =
    arm === 'b2'
      ? personaWithStorybook(DEFAULT_LANGUAGE, CAT_SCENES)
      : personaForLanguage(DEFAULT_LANGUAGE);
  const persona_contains_barnaby = /barnaby/i.test(persona);

  console.log(`\n[arm=${arm}] persona has Barnaby in system prompt: ${persona_contains_barnaby}`);

  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });
  const agent = new Agent({ name: `say-ctx-${arm}-${Date.now()}`, instructions: persona, greeting: '' })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: STORYTELLER_VOICE_ID }))
    .withFillerWords(PHASE3_FILLER)
    .withTurnDetection(PHASE3_TURN)
    .withAdvancedFeatures(PHASE3_ADVANCED)
    .withParameters(PHASE3_PARAMS);

  const session = agent.createSession(client, {
    channel: `say-ctx-${arm}-${Date.now()}`,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(3),
    debug: false,
  });

  try {
    await session.start();
    await new Promise((r) => setTimeout(r, 3000));
    // Narrate like the real narrator: APPEND each scene.
    for (const scene of CAT_SCENES) {
      await session.say(scene.narration_text, { priority: 'APPEND' });
    }
    // Let the queue drain (~ sum of durations).
    const drainMs = CAT_SCENES.reduce(
      (acc, s) => acc + Math.max(700, Math.round((s.narration_text.length / 17) * 1000)) + 150,
      0,
    );
    await new Promise((r) => setTimeout(r, Math.round(drainMs * 1.2)));

    // Read history (retry — propagation can lag a beat).
    let history: unknown = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        history = await session.getHistory();
        if (history) break;
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    await session.stop();

    const historyStr = JSON.stringify(history ?? {});
    return {
      arm,
      persona_contains_barnaby,
      history_contains_barnaby: /barnaby/i.test(historyStr),
      history_raw: history,
    };
  } catch (err) {
    try { await session.stop(); } catch {}
    return {
      arm,
      persona_contains_barnaby,
      history_contains_barnaby: false,
      history_raw: null,
      error: (err as Error).message,
    };
  }
}

async function main() {
  const results: ArmResult[] = [];
  for (const arm of ['control', 'b2'] as const) {
    results.push(await runArm(arm));
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(repoRoot, 'docs/experiments/2026-05-30-say-context/data');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'probe.json'), JSON.stringify(results, null, 2));

  console.log('\n=== VERDICT ===');
  const control = results.find((r) => r.arm === 'control');
  const b2 = results.find((r) => r.arm === 'b2');
  if (control?.error || b2?.error) {
    console.log(`  ⚠️  errors — control: ${control?.error ?? 'ok'} | b2: ${b2?.error ?? 'ok'}`);
  }
  console.log(`  control (no injection): say()-narration reaches getHistory? ${control?.history_contains_barnaby ? 'YES → say() feeds context (root cause = maxHistory eviction)' : 'NO → say() does NOT feed context (B2 injection is required)'}`);
  console.log(`  b2 (storybook injection): Barnaby in system prompt? ${b2?.persona_contains_barnaby ? 'YES ✓' : 'NO ✗ (B2 broken!)'} | in getHistory? ${b2?.history_contains_barnaby ? 'YES' : '(system prompts may not echo in getHistory — see raw)'}`);
  console.log(`\n  Raw history written to ${outDir}/probe.json`);
}

main().catch((e) => { console.error('probe fatal:', e); process.exit(1); });

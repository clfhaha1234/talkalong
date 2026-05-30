// PROBE — does session.update({ llm: { system_messages } }) actually work
// mid-session? This verifies the MECHANISM of the context-sync fix (the robust
// "what's the cat's name?" fix that pushes narrated-so-far into the agent's
// system context after each segment).
//
// We start a real session, narrate two scenes, then call session.update() with
// a narrated-so-far system message — exactly as the orchestrator's syncContext
// does — and assert the call resolves without error. A throw here would mean
// the orchestrator's per-segment context-sync silently fails in prod (the
// callback is fire-and-forget + caught, so a broken update() would NOT crash
// the session but WOULD leave the agent context-blind → cat-name bug returns).
//
// Run: pnpm tsx scripts/probes/update-context-probe.ts

import {
  Agent,
  AgoraClient,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';
import { env } from '../e1/lib/env.js';
import { personaForLanguage, DEFAULT_LANGUAGE, STORYTELLER_VOICE_ID } from '../../lib/language-config.js';

const SCENES = [
  'Barnaby was a cat who lived in the shadows of the old library.',
  'One night he found a book of glowing stars left open on a desk.',
];

async function main() {
  const client = new AgoraClient({ area: Area.US, appId: env.agoraAppId, appCertificate: env.agoraAppCertificate });
  const agent = new Agent({ name: `update-probe-${Date.now()}`, instructions: personaForLanguage(DEFAULT_LANGUAGE), greeting: '' })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: STORYTELLER_VOICE_ID }));
  const session = agent.createSession(client, {
    channel: `update-probe-${Date.now()}`,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(3),
  });

  let updateOk = false;
  let updateErr: string | null = null;
  try {
    await session.start();
    await new Promise((r) => setTimeout(r, 3000));
    await session.say(SCENES[0], { priority: 'APPEND' });
    await new Promise((r) => setTimeout(r, 2000));
    // The exact shape the orchestrator's syncContext uses:
    try {
      await session.update({
        llm: {
          system_messages: [
            { role: 'system', content: personaForLanguage(DEFAULT_LANGUAGE) },
            { role: 'system', content: `The story you have narrated SO FAR:\nScene 1: ${SCENES[0]}` },
          ],
        },
      });
      updateOk = true;
    } catch (e) {
      updateErr = (e as Error).message;
    }
    await session.say(SCENES[1], { priority: 'APPEND' });
    await new Promise((r) => setTimeout(r, 2000));
    await session.stop();
  } catch (e) {
    try { await session.stop(); } catch {}
    console.log('session error:', (e as Error).message);
  }

  console.log('\n=== UPDATE-CONTEXT PROBE VERDICT ===');
  console.log(`  session.update({llm:{system_messages}}) mid-session: ${updateOk ? '✅ SUCCEEDED — context-sync mechanism works' : '❌ FAILED: ' + updateErr}`);
  if (!updateOk) process.exitCode = 1;
}

main().catch((e) => { console.error('probe fatal:', e); process.exit(1); });

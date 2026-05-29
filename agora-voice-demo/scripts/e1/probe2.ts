// Probe v2: does getTurns() work AFTER session.stop()?
//
// Hypothesis: getTurns() is a post-hoc analytics endpoint. If we call it
// after the session has stopped, it should return populated turn data.

import {
  AgoraClient,
  Area,
  ExpiresIn,
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
} from 'agora-agent-server-sdk';
import { env } from './lib/env.js';

async function main() {
  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });

  const agent = new Agent({
    name: `e1-probe2-${Date.now()}`,
    instructions: `You are a silent narrator. Do not initiate speech.`,
    greeting: ``,
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini' }))
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: 'English_captivating_female1',
      }),
    );

  const session = agent.createSession(client, {
    channel: `e1-probe2-${Date.now()}`,
    agentUid: env.agentUid,
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(5),
    debug: false,
  });

  console.log('[probe2] starting...');
  const t0 = Date.now();
  const agentId = await session.start();
  console.log(`[probe2] running id=${agentId}`);

  // Cycle 1: say + wait for some audio + interrupt
  await new Promise((r) => setTimeout(r, 800));
  const say1Ts = Date.now();
  console.log(`[probe2] say #1 at +${say1Ts - t0}ms`);
  await session.say('This is the first probe cycle, a moderately long sentence.', { priority: 'INTERRUPT' });
  await new Promise((r) => setTimeout(r, 1800));
  const int1Ts = Date.now();
  console.log(`[probe2] interrupt #1 at +${int1Ts - t0}ms (+${int1Ts - say1Ts}ms after say)`);
  await session.interrupt();

  // Cycle 2
  await new Promise((r) => setTimeout(r, 1500));
  const say2Ts = Date.now();
  console.log(`[probe2] say #2 at +${say2Ts - t0}ms`);
  await session.say('And here comes the second probe cycle, another moderately long sentence.', { priority: 'INTERRUPT' });
  await new Promise((r) => setTimeout(r, 1500));
  const int2Ts = Date.now();
  console.log(`[probe2] interrupt #2 at +${int2Ts - t0}ms (+${int2Ts - say2Ts}ms after say)`);
  await session.interrupt();

  // Try getTurns BEFORE stop (expecting 404)
  await new Promise((r) => setTimeout(r, 1000));
  console.log('[probe2] getTurns() before stop:');
  try {
    const t = await session.getTurns();
    console.log(`  turns=${(t.turns ?? []).length}`);
    for (const turn of t.turns ?? []) {
      console.log(`  pre-stop turn_id=${turn.turn_id} start.type=${turn.start?.type} start_at=${turn.start?.start_at} end.type=${turn.end?.type} end_caused=${turn.end?.metadata?.caused_by}`);
    }
  } catch (err) {
    console.log(`  pre-stop getTurns() failed: ${(err as Error).message.split('\n')[0]}`);
  }

  console.log('[probe2] stopping session...');
  await session.stop();
  console.log('[probe2] stopped');

  // Try getTurns AFTER stop
  for (const delay of [0, 1000, 3000, 8000]) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay - (delay === 1000 ? 0 : 1000)));
    console.log(`[probe2] getTurns() at +${delay}ms after stop:`);
    try {
      const t = await session.getTurns();
      const turns = t.turns ?? [];
      console.log(`  turns=${turns.length}`);
      for (const turn of turns) {
        console.log(
          `  turn_id=${turn.turn_id} start.type=${turn.start?.type} start_at=${turn.start?.start_at} end.type=${turn.end?.type} end_caused=${turn.end?.metadata?.caused_by} playback=${turn.end?.metadata?.playback_duration_ms ?? '?'}ms tts_ttfb=${turn.metrics?.segmented_latency_ms?.find((s) => s.name === 'tts_ttfb')?.latency ?? '?'}`,
        );
      }
      if (turns.length > 0) break;
    } catch (err) {
      console.log(`  failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  console.log('[probe2] done');
}

main().catch((err) => {
  console.error('probe2 fatal:', err);
  process.exit(1);
});

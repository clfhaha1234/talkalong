// Probe v3: confirm we can compute C1 and C2 post-stop from turn data alone.
//
// We will record local timestamps for each say()/interrupt() call. After stop,
// fetch getTurns() once and match turns to our local events by start_at order.

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
    name: `e1-probe3-${Date.now()}`,
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
    channel: `e1-probe3-${Date.now()}`,
    agentUid: env.agentUid,
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(5),
    debug: false,
  });

  await session.start();
  console.log(`agentId=${session.id}`);

  type Local = { row: string; say_ts: number; int_ts: number; text: string };
  const local: Local[] = [];

  const sentences = [
    'First short sentence for cycle one.',
    'Second sentence with slightly different content for cycle two.',
    'Third sentence introducing some numbers like 42 and 99.',
    'Fourth sentence with a quoted "phrase" embedded inside.',
    'Fifth and final sentence to round out the probe run.',
  ];

  await new Promise((r) => setTimeout(r, 800));

  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const sayTs = Date.now();
    await session.say(text, { priority: 'INTERRUPT' });
    await new Promise((r) => setTimeout(r, 1500));
    const intTs = Date.now();
    await session.interrupt();
    local.push({ row: `c${i + 1}`, say_ts: sayTs, int_ts: intTs, text });
    console.log(`  cycle ${i + 1}: say=${sayTs} interrupt=${intTs} (+${intTs - sayTs}ms)`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log('stopping session...');
  await session.stop();

  // Wait for turn analytics to propagate
  let turns: NonNullable<Awaited<ReturnType<typeof session.getTurns>>['turns']> = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const t = await session.getTurns();
      if (t.turns && t.turns.length > 0) {
        turns = t.turns;
        console.log(`turns available after ${(i + 1) * 500}ms: ${turns.length}`);
        break;
      }
    } catch {
      // keep polling
    }
  }

  // Filter to api_speak turns and order by start_at
  const apiSpeakTurns = turns
    .filter((t) => t.start?.type === 'api_speak' && typeof t.start.start_at === 'number')
    .sort((a, b) => (a.start!.start_at as number) - (b.start!.start_at as number));

  console.log(`\nMatching ${local.length} local cycles against ${apiSpeakTurns.length} api_speak turns:`);
  console.log('cycle | local_say_ts → start_at  Δ  | tts_ttfb | end_at - int_ts (C1) | end_caused | playback');
  for (let i = 0; i < Math.max(local.length, apiSpeakTurns.length); i++) {
    const l = local[i];
    const t = apiSpeakTurns[i];
    if (!l || !t) {
      console.log(`  cycle ${i + 1}: unmatched (local=${!!l} turn=${!!t})`);
      continue;
    }
    const startAt = t.start!.start_at as number;
    const ttsTtfb = t.metrics?.segmented_latency_ms?.find((s) => s.name === 'tts_ttfb')?.latency ?? null;
    const endAt = t.end?.end_at ?? null;
    const c1 = endAt != null ? endAt - l.int_ts : null;
    const startDelta = startAt - l.say_ts;
    console.log(
      `  c${i + 1}    | ${l.say_ts} → ${startAt}  (Δ=${startDelta}ms)  | ttfb=${ttsTtfb}ms | C1=${c1}ms | ${t.end?.metadata?.caused_by ?? '?'} | playback=${t.end?.metadata?.playback_duration_ms ?? '?'}ms`,
    );
  }

  // Print full per-stage latency breakdown for cycle 1
  if (apiSpeakTurns[0]) {
    console.log('\nfull metrics for first matched turn:');
    console.log(JSON.stringify(apiSpeakTurns[0], null, 2));
  }
}

main().catch((err) => {
  console.error('probe3 fatal:', err);
  process.exit(1);
});

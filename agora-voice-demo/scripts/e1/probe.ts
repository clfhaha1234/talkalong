// Diagnostic probe: start a session, wait, say(), poll getTurns() loudly.
//
// Goal: discover the actual turn type string + propagation delay.

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
    name: `e1-probe-${Date.now()}`,
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
    channel: `e1-probe-${Date.now()}`,
    agentUid: env.agentUid,
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(5),
    debug: false,
  });

  console.log('[probe] starting session...');
  const t0 = Date.now();
  const agentId = await session.start();
  console.log(`[probe] start() returned in ${Date.now() - t0}ms — agentId=${agentId}, status=${session.status}`);

  // Poll status until running
  for (let i = 0; i < 50; i++) {
    if (session.status === 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[probe] after wait, status=${session.status} (${Date.now() - t0}ms since start)`);

  // Poll getTurns BEFORE any say — what's there at idle?
  try {
    const pre = await session.getTurns();
    console.log(`[probe] preTurns count=${pre.turns?.length ?? 0}`);
    for (const t of pre.turns ?? []) {
      console.log(`  pre turn_id=${t.turn_id} start.type=${t.start?.type} start_at=${t.start?.start_at} end.type=${t.end?.type}`);
    }
  } catch (err) {
    console.log(`[probe] getTurns() pre-say failed: ${(err as Error).message}`);
  }

  // Sleep 1s, then say
  await new Promise((r) => setTimeout(r, 1000));

  const sayTs = Date.now();
  console.log(`[probe] calling say() at t=${sayTs - t0}ms ...`);
  try {
    await session.say('Hello, this is a probe test sentence.', { priority: 'INTERRUPT' });
    console.log(`[probe] say() returned in ${Date.now() - sayTs}ms`);
  } catch (err) {
    console.log(`[probe] say() failed: ${(err as Error).message}`);
  }

  // Poll getTurns every 250ms for up to 12s
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const t = await session.getTurns();
      const turns = t.turns ?? [];
      const last = turns[turns.length - 1];
      const tag = last
        ? `last turn_id=${last.turn_id} start.type=${last.start?.type} start_at=${last.start?.start_at} (delta=${(last.start?.start_at ?? 0) - sayTs}ms) end.type=${last.end?.type ?? '...'} end_caused=${last.end?.metadata?.caused_by ?? '...'}`
        : 'no turns yet';
      console.log(`[probe] poll ${i} (${Date.now() - sayTs}ms after say): turns=${turns.length}  ${tag}`);
      if (last?.end?.end_at) break;
    } catch (err) {
      console.log(`[probe] poll ${i} failed: ${(err as Error).message}`);
    }
  }

  // After speech, try interrupt
  console.log(`[probe] testing interrupt — saying long text then interrupting at 1500ms`);
  const longText =
    'This is a long sentence designed to give the test enough audio time so that we can fire an interrupt while it is still being read out and capture the resulting end event with the cause attribute set to api interrupt and we will see whether the latency between the interrupt call and the silence event is small enough to support the proactive tutor barge in design.';

  const sayTs2 = Date.now();
  await session.say(longText, { priority: 'INTERRUPT' });
  console.log(`[probe] say() #2 returned in ${Date.now() - sayTs2}ms`);
  await new Promise((r) => setTimeout(r, 1500));
  const intTs = Date.now();
  console.log(`[probe] calling interrupt() at +${intTs - sayTs2}ms ...`);
  await session.interrupt();
  console.log(`[probe] interrupt() returned in ${Date.now() - intTs}ms`);
  // poll until we see the interrupt-caused end
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const t = await session.getTurns();
    const turns = t.turns ?? [];
    const last = turns[turns.length - 1];
    if (last) {
      console.log(`[probe] post-int poll ${i}: turn_id=${last.turn_id} start.type=${last.start?.type} start_at=${last.start?.start_at} (delta=${(last.start?.start_at ?? 0) - sayTs2}ms) end.type=${last.end?.type ?? '...'} end_at=${last.end?.end_at ?? '...'} end_caused=${last.end?.metadata?.caused_by ?? '...'} playback=${last.end?.metadata?.playback_duration_ms ?? '...'}ms`);
      if (last.end?.type === 'interrupted') break;
    }
  }

  // Dump full history
  try {
    const h = await session.getHistory();
    console.log(`[probe] history: ${(h.contents ?? []).length} items`);
    for (const item of h.contents ?? []) {
      const role = (item as Record<string, unknown>).role;
      const content = (item as Record<string, unknown>).content;
      const c = String(content ?? '').slice(0, 80);
      console.log(`  history role=${role} content="${c}${String(content).length > 80 ? '...' : ''}"`);
    }
  } catch (err) {
    console.log(`[probe] getHistory() failed: ${(err as Error).message}`);
  }

  console.log('[probe] stopping session...');
  await session.stop();
  console.log('[probe] done');
}

main().catch((err) => {
  console.error('probe fatal:', err);
  process.exit(1);
});

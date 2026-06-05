// Honest A/B: time-to-first-PLAYABLE-AUDIO, streaming route vs. the
// non-streaming baseline, alternating in the same session so StepFun's
// time-varying latency hits both arms equally.
//   A (stream):   POST /api/stepfun/voice-qa-stream → first 'audio' SSE event
//   B (baseline): stepASR + stepChat(full) + stepTTS(full) → audio ready at the end
//   node --import tsx scripts/stepfun/ab-latency.ts
import { readFileSync } from 'node:fs';
import { stepASR, stepChat, stepTTS } from '@/lib/stepfun/client';
import { STEPFUN_QA_SYSTEM, stepfunQaUserMessage } from '@/lib/stepfun/persona';

for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const BASE = process.env.PROBE_BASE ?? 'http://localhost:3001';
const STORY = 'When the moon rose over the library, Pemberley the cat began her quiet nightly patrol between the tall shelves.';

async function makeClip(): Promise<Buffer> {
  return stepTTS('What is the name of the cat?', { voice: 'lively-girl' });
}

async function streaming(clip: Buffer): Promise<number | null> {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(clip)], { type: 'audio/mp3' }), 'q.mp3');
  fd.append('storySoFar', STORY);
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/stepfun/voice-qa-stream`, { method: 'POST', body: fd });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:')); if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.t === 'audio') { try { reader.cancel(); } catch { /* */ } return Math.round(performance.now() - t0); }
      if (ev.t === 'backChannel' || ev.t === 'error') return null;
    }
  }
  return null;
}

async function baseline(clip: Buffer): Promise<number | null> {
  const t0 = performance.now();
  const q = (await stepASR(new Blob([new Uint8Array(clip)], { type: 'audio/mp3' }), 'q.mp3')).trim();
  if (q.length < 2) return null;
  const answer = await stepChat(
    [{ role: 'system', content: STEPFUN_QA_SYSTEM }, { role: 'user', content: stepfunQaUserMessage(q, STORY) }],
    { reasoningEffort: 'low', maxTokens: 2048, temperature: 0 },
  );
  await stepTTS(answer || 'one moment', { voice: 'lively-girl' }); // whole clip — only now playable
  return Math.round(performance.now() - t0);
}

(async () => {
  const clip = await makeClip();
  const A: number[] = []; const B: number[] = [];
  console.log('round   stream(first-audio)   baseline(audio-ready)');
  for (let i = 0; i < 5; i++) {
    // alternate order each round so neither arm is systematically favored
    let a: number | null, b: number | null;
    if (i % 2 === 0) { a = await streaming(clip); b = await baseline(clip); }
    else { b = await baseline(clip); a = await streaming(clip); }
    if (a != null) A.push(a); if (b != null) B.push(b);
    console.log(`  ${i + 1}        ${String(a ?? 'skip').padStart(6)} ms            ${String(b ?? 'skip').padStart(6)} ms`);
  }
  const med = (xs: number[]) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : NaN;
  console.log(`\nmedian  stream=${med(A)}ms   baseline=${med(B)}ms   improvement=${med(B) - med(A)}ms (${Math.round((1 - med(A) / med(B)) * 100)}% faster to first sound)`);
})().catch((e) => { console.error(e); process.exit(1); });

// Verify /api/stepfun/voice-qa-stream end-to-end against the dev server.
// Synthesizes a spoken question, POSTs it, parses the SSE, and measures
// time-to-first-audio vs. total — compared to the ~4.5s non-streaming baseline.
//   node --import tsx scripts/stepfun/verify-stream.ts
import { readFileSync } from 'node:fs';
import { stepTTS } from '@/lib/stepfun/client';

for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const BASE = process.env.PROBE_BASE ?? 'http://localhost:3001';
const STORY =
  'When the moon rose over the library, Pemberley the cat began her quiet nightly patrol between the tall shelves, her green eyes catching every shadow.';

async function run(label: string, questionText: string, story: string) {
  // 1) make a spoken-question clip (what the mic would capture)
  const qAudio = await stepTTS(questionText, { voice: 'lively-girl' });
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(qAudio)], { type: 'audio/mp3' }), 'q.mp3');
  fd.append('storySoFar', story);

  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/stepfun/voice-qa-stream`, { method: 'POST', body: fd });
  const ms = () => Math.round(performance.now() - t0);
  if (!res.ok || !res.body) { console.log(`${label}: HTTP ${res.status} ${await res.text()}`); return; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstAudio: number | null = null;
  let metaAt: number | null = null;
  let answerAt: number | null = null;
  let audioBytes = 0, chunks = 0, question = '', answer = '', backChannel = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.t === 'meta') { metaAt = ms(); question = ev.question; }
      else if (ev.t === 'backChannel') { backChannel = true; console.log(`${label}: backChannel echo=${!!ev.echo} @${ms()}ms`); }
      else if (ev.t === 'answer') { answerAt = ms(); answer = ev.answer; }
      else if (ev.t === 'audio') { if (firstAudio === null) firstAudio = ms(); chunks++; audioBytes += Buffer.from(ev.audio, 'base64').length; }
      else if (ev.t === 'error') console.log(`${label}: ERROR ${ev.message} @${ms()}ms`);
    }
  }
  if (backChannel) return;
  console.log(`${label}:`);
  console.log(`  meta(question)@ ${metaAt}ms  "${question}"`);
  console.log(`  FIRST AUDIO  @ ${firstAudio}ms   <-- time-to-first-sound`);
  console.log(`  answer       @ ${answerAt}ms  "${answer}"`);
  console.log(`  total stream @ ${ms()}ms  (${chunks} chunks, ${audioBytes}B)`);
}

(async () => {
  await run('Q-real (cat name)', 'What is the name of the cat?', STORY);
  console.log('');
  await run('Q-echo (narration)', 'Pemberley the cat began her quiet nightly patrol', STORY);
})().catch((e) => { console.error(e); process.exit(1); });

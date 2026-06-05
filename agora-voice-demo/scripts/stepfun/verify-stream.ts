// Verify /api/stepfun/voice-qa-stream end-to-end against the dev server.
// Synthesizes spoken questions, POSTs them, parses the SSE, and asserts the
// tutor-critical contract:
//   - real question: ASR meta -> answer text -> streamed audio chunks -> done
//   - narration echo: backChannel -> done, no answer/audio
//   - mic check: short acknowledgement + hold=true, so the UI keeps listening
//
// This intentionally mirrors the tutor barge-in benchmark posture: printing
// latencies is not enough; regressions must fail the process.
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

interface StreamProbeResult {
  label: string;
  question: string;
  answer: string;
  backChannel: boolean;
  hold: boolean;
  echo: boolean;
  errors: string[];
  done: boolean;
  metaAt: number | null;
  answerAt: number | null;
  firstAudioAt: number | null;
  totalAt: number;
  chunks: number;
  audioBytes: number;
}

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

async function run(label: string, questionText: string, story: string): Promise<StreamProbeResult> {
  // 1) make a spoken-question clip (what the mic would capture)
  const qAudio = await stepTTS(questionText, { voice: 'lively-girl' });
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(qAudio)], { type: 'audio/mp3' }), 'q.mp3');
  fd.append('storySoFar', story);

  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/stepfun/voice-qa-stream`, { method: 'POST', body: fd });
  const ms = () => Math.round(performance.now() - t0);
  if (!res.ok || !res.body) fail(label, `HTTP ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let firstAudioAt: number | null = null;
  let metaAt: number | null = null;
  let answerAt: number | null = null;
  let totalAt = 0;
  let audioBytes = 0;
  let chunks = 0;
  let question = '';
  let answer = '';
  let backChannel = false;
  let hold = false;
  let echo = false;
  let doneEvent = false;
  const errors: string[] = [];

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
      else if (ev.t === 'backChannel') { backChannel = true; echo = !!ev.echo; }
      else if (ev.t === 'answer') { answerAt = ms(); answer = ev.answer; hold = !!ev.hold; }
      else if (ev.t === 'audio') { if (firstAudioAt === null) firstAudioAt = ms(); chunks++; audioBytes += Buffer.from(ev.audio, 'base64').length; }
      else if (ev.t === 'error') errors.push(String(ev.message ?? 'stream error'));
      else if (ev.t === 'done') { doneEvent = true; totalAt = ms(); }
    }
  }
  if (!totalAt) totalAt = ms();
  return {
    label,
    question,
    answer,
    backChannel,
    hold,
    echo,
    errors,
    done: doneEvent,
    metaAt,
    answerAt,
    firstAudioAt,
    totalAt,
    chunks,
    audioBytes,
  };
}

function assertRealQuestion(r: StreamProbeResult) {
  if (r.errors.length) fail(r.label, `unexpected error events: ${r.errors.join('; ')}`);
  if (!r.done) fail(r.label, 'missing done event');
  if (r.backChannel) fail(r.label, 'real question was misclassified as backChannel');
  if (!r.metaAt || !r.question) fail(r.label, 'missing ASR meta question');
  if (!/cat|name/i.test(r.question)) fail(r.label, `ASR question looks wrong: "${r.question}"`);
  if (!r.answerAt || !r.answer) fail(r.label, 'missing answer text');
  if (!/pemberley/i.test(r.answer)) fail(r.label, `answer did not name Pemberley: "${r.answer}"`);
  if (!r.firstAudioAt || r.chunks < 1 || r.audioBytes < 1000) fail(r.label, 'missing streamed audio chunks');

  const maxFirstAudioMs = Number(process.env.STEPFUN_MAX_FIRST_AUDIO_MS ?? 12000);
  const maxTotalMs = Number(process.env.STEPFUN_MAX_TOTAL_STREAM_MS ?? 25000);
  if (r.firstAudioAt > maxFirstAudioMs) fail(r.label, `first audio too slow: ${r.firstAudioAt}ms > ${maxFirstAudioMs}ms`);
  if (r.totalAt > maxTotalMs) fail(r.label, `stream too slow: ${r.totalAt}ms > ${maxTotalMs}ms`);
}

function assertEchoBackChannel(r: StreamProbeResult) {
  if (r.errors.length) fail(r.label, `unexpected error events: ${r.errors.join('; ')}`);
  if (!r.done) fail(r.label, 'missing done event');
  if (!r.backChannel || !r.echo) fail(r.label, 'narration echo was not classified as echo backChannel');
  if (r.answer || r.chunks || r.audioBytes) fail(r.label, 'echo path should not answer or stream audio');
}

function assertMicCheck(r: StreamProbeResult) {
  if (r.errors.length) fail(r.label, `unexpected error events: ${r.errors.join('; ')}`);
  if (!r.done) fail(r.label, 'missing done event');
  if (r.backChannel) fail(r.label, 'mic check should answer briefly, not backChannel');
  if (!r.metaAt || !r.question) fail(r.label, 'missing ASR meta question');
  if (!r.answerAt || !r.answer) fail(r.label, 'missing mic-check answer text');
  if (!r.hold) fail(r.label, 'mic-check answer must set hold=true so narration does not auto-resume');
  if (!/hear|ask|question/i.test(r.answer)) fail(r.label, `mic-check answer looks wrong: "${r.answer}"`);
  if (!r.firstAudioAt || r.chunks < 1 || r.audioBytes < 1000) fail(r.label, 'missing streamed audio chunks');
}

function printResult(r: StreamProbeResult) {
  console.log(`${r.label}:`);
  if (r.backChannel) {
    console.log(`  backChannel echo=${r.echo} total=${r.totalAt}ms`);
    return;
  }
  console.log(`  meta(question)@ ${r.metaAt}ms  "${r.question}"`);
  console.log(`  FIRST AUDIO  @ ${r.firstAudioAt}ms   <-- time-to-first-sound`);
  console.log(`  answer       @ ${r.answerAt}ms  hold=${r.hold}  "${r.answer}"`);
  console.log(`  total stream @ ${r.totalAt}ms  (${r.chunks} chunks, ${r.audioBytes}B)`);
}

(async () => {
  const real = await run('Q-real (cat name)', 'What is the name of the cat?', STORY);
  printResult(real);
  assertRealQuestion(real);
  console.log('');
  const echo = await run('Q-echo (narration)', 'Pemberley the cat began her quiet nightly patrol', STORY);
  printResult(echo);
  assertEchoBackChannel(echo);
  console.log('');
  const mic = await run('Q-mic-check (hold)', 'Can you hear me?', STORY);
  printResult(mic);
  assertMicCheck(mic);
})().catch((e) => { console.error(e); process.exit(1); });

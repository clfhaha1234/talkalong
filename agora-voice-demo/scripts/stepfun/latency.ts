// Stage-by-stage latency probe for the StepFun voice-QA pipeline.
// Isolates: is the reasoning LLM (step-3.7-flash) the bottleneck, and how much
// is the internal "thinking" pass vs. plain decode + TTS?
//   node --import tsx scripts/stepfun/latency.ts
import { readFileSync } from 'node:fs';
import { stepTTS, stepASR } from '@/lib/stepfun/client';

for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.STEPFUN_API_KEY!;
const BASE = 'https://api.stepfun.ai/v1';

const SYSTEM = 'You are a warm storybook narrator. Answer the child in ONE short sentence, in character.';
const USER =
  'Story so far: "When the moon rose over the library, Pemberley the cat began her quiet nightly patrol."\nThe child asks: What is the name of the cat?';

async function chat(model: string, extra: Record<string, unknown>) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }], max_tokens: 512, temperature: 0, ...extra }),
  });
  const j = await r.json();
  const ms = Math.round(performance.now() - t0);
  const c = j.choices?.[0]?.message?.content?.trim() || `ERR ${JSON.stringify(j).slice(0, 80)}`;
  return { ms, c, ctok: j.usage?.completion_tokens ?? 0 };
}

async function main() {
  console.log('=== LLM A/B: reasoning (3.7) vs flash (3.5) ===');
  const agg: Record<string, number[]> = { '3.7': [], '3.5': [] };
  for (let i = 0; i < 4; i++) {
    const a = await chat('step-3.7-flash', { reasoning_effort: 'low' });
    const b = await chat('step-3.5-flash', {});
    agg['3.7'].push(a.ms); agg['3.5'].push(b.ms);
    console.log(`run${i + 1}  3.7-flash ${String(a.ms).padStart(5)}ms (${a.ctok}tok)  |  3.5-flash ${String(b.ms).padStart(5)}ms (${b.ctok}tok)`);
    console.log(`       3.7> ${JSON.stringify(a.c.slice(0, 58))}`);
    console.log(`       3.5> ${JSON.stringify(b.c.slice(0, 58))}`);
  }
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`\nmedian  3.7-flash=${med(agg['3.7'])}ms   3.5-flash=${med(agg['3.5'])}ms   thinking-tax≈${med(agg['3.7']) - med(agg['3.5'])}ms\n`);

  console.log('=== TTS + ASR (3 runs) ===');
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const mp3 = await stepTTS('The cat\'s name is Pemberley, dear.', { voice: 'lively-girl' }).catch(() => Buffer.alloc(0));
    const tts = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const txt = mp3.length ? await stepASR(mp3, 'a.mp3').catch(() => 'ERR') : 'skip';
    const asr = Math.round(performance.now() - t1);
    console.log(`run${i + 1}  TTS ${String(tts).padStart(5)}ms (${mp3.length}B)  |  ASR ${String(asr).padStart(5)}ms  ${JSON.stringify(txt.slice(0, 30))}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

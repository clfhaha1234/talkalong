// Probe: why are gemini-3-flash-preview / gemini-3.5-flash responses truncated?
// Hypothesis: thinking tokens consume max_tokens before the visible reply starts.
// Test: bump max_tokens to 4096; also capture finish_reason; also try
// reasoning_effort="none" or "minimal" if supported.

import { env } from '../e1/lib/env.js';

const MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const PROMPT = 'Wait — pruning attention heads, like permanently or just at inference time?';
const SYSTEM = `You are a warm, sharp voice tutor. Keep replies to 1-2 sentences. The paper prunes attention heads at inference time.`;

async function probe(model: string, maxTokens: number, extra: Record<string, unknown> = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: PROMPT },
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: maxTokens,
    ...extra,
  };
  const t0 = Date.now();
  let ttft: number | null = null;
  let text = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;

  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.geminiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const e = await res.text();
    return { error: `HTTP ${res.status}: ${e.slice(0, 300)}`, ttft, total: Date.now() - t0, text, finishReason, usage };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const c = JSON.parse(payload);
        const delta = c.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          if (ttft === null) ttft = Date.now() - t0;
          text += delta;
        }
        const fr = c.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        if (c.usage) usage = c.usage;
      } catch {}
    }
  }
  return { ttft, total: Date.now() - t0, text, finishReason, usage };
}

async function main() {
  console.log(`Prompt: "${PROMPT}"\n`);
  for (const max of [256, 1024, 4096]) {
    console.log(`\n=== max_tokens=${max} ===`);
    for (const model of MODELS) {
      const r = await probe(model, max);
      const errStr = (r as any).error ? `\n    ERR: ${(r as any).error}` : '';
      console.log(`\n  [${model}]`);
      console.log(`    ttft=${r.ttft}ms  total=${r.total}ms  chars=${r.text.length}  finish=${r.finishReason}${errStr}`);
      console.log(`    usage: ${JSON.stringify(r.usage)}`);
      console.log(`    text: "${r.text}"`);
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  // Also: probe with reasoning_effort minimal (Gemini OpenAI-compat may accept this)
  console.log(`\n\n=== reasoning_effort: 'minimal' (max_tokens=1024) ===`);
  for (const model of MODELS) {
    const r = await probe(model, 1024, { reasoning_effort: 'minimal' });
    const errStr = (r as any).error ? `\n    ERR: ${(r as any).error}` : '';
    console.log(`\n  [${model}]`);
    console.log(`    ttft=${r.ttft}ms  total=${r.total}ms  chars=${r.text.length}  finish=${r.finishReason}${errStr}`);
    console.log(`    usage: ${JSON.stringify(r.usage)}`);
    console.log(`    text: "${r.text}"`);
    await new Promise((res) => setTimeout(res, 300));
  }
}

main().catch((e) => { console.error('probe fatal:', e); process.exit(1); });

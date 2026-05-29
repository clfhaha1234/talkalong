// Gemini Flash 3.x quick bench: TTFT + total latency + quality side-by-side.
//
// Endpoint: Gemini's OpenAI-compatible chat completions stream.
// We measure:
//   - TTFT (time-to-first-token): wall clock from POST to first SSE chunk with content
//   - total_ms: wall clock from POST to [DONE]
//   - output_chars: response length (proxy for tokens; ~3.5 chars/token for English)
//   - response_text: captured for quality eyeball

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../e1/lib/env.js';

const MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

// Voice-tutor system prompt (mirrors Ada persona from agora-voice-demo)
const SYSTEM_PROMPT = `You are a warm, sharp voice tutor explaining a research paper to a smart non-specialist. The conversation is by voice, so:
- Keep replies to 1-2 sentences. No bullet points, no lists.
- If the user asks something complex, answer the most important part first; ask one focused follow-up if needed.
- Don't lecture. Don't preface with "Great question". Just answer.
- If you don't know, say so plainly.
The paper is about pruning attention heads in transformers based on gradient-contribution scoring — they prune the bottom 30% of heads at inference time and report 1.5pp accuracy drop on GLUE.`;

// Realistic Q&A turns the tutor would face
const PROMPTS: { id: string; text: string; category: string }[] = [
  {
    id: 'p1_followup',
    category: 'technical_followup',
    text: 'Wait — pruning attention heads, like permanently or just at inference time?',
  },
  {
    id: 'p2_why',
    category: 'conceptual_why',
    text: 'Why do you think they got better results on language tasks than vision?',
  },
  {
    id: 'p3_compare',
    category: 'compare',
    text: 'How is this different from regular weight pruning?',
  },
  {
    id: 'p4_eli15',
    category: 'simplify',
    text: 'Can you explain transformer attention like I am in high school?',
  },
  {
    id: 'p5_deploy',
    category: 'practical',
    text: 'Is this actually used in production anywhere?',
  },
  {
    id: 'p6_confused',
    category: 'confusion',
    text: "Hmm, I don't get why they chose this baseline.",
  },
];

const TRIALS_PER_PROMPT = 2;

type Sample = {
  model: string;
  prompt_id: string;
  trial: number;
  ttft_ms: number | null;
  total_ms: number;
  output_chars: number;
  response: string;
  error?: string;
};

async function streamOne(model: string, userPrompt: string): Promise<{
  ttft_ms: number | null;
  total_ms: number;
  text: string;
  error?: string;
}> {
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 1024,
    // CRITICAL: without this, gemini-3-flash-preview and gemini-3.5-flash
    // default to thinking mode and burn max_tokens budget on internal reasoning
    // BEFORE producing any visible output. Voice latency dies under that.
    reasoning_effort: 'minimal',
  };
  const t0 = Date.now();
  let ttft: number | null = null;
  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.geminiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text();
      return { ttft_ms: null, total_ms: Date.now() - t0, text: '', error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE chunks separated by \n\n; each line starts with "data: "
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            if (ttft === null) ttft = Date.now() - t0;
            text += delta;
          }
        } catch {
          // ignore non-JSON chunks
        }
      }
    }
    return { ttft_ms: ttft, total_ms: Date.now() - t0, text };
  } catch (err) {
    return { ttft_ms: null, total_ms: Date.now() - t0, text, error: (err as Error).message };
  }
}

async function main() {
  if (!env.geminiApiKey) {
    console.error('GOOGLE_API_KEY missing in env');
    process.exit(1);
  }

  const samples: Sample[] = [];

  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    for (const prompt of PROMPTS) {
      for (let trial = 1; trial <= TRIALS_PER_PROMPT; trial++) {
        process.stdout.write(`  ${prompt.id} t${trial} ... `);
        const r = await streamOne(model, prompt.text);
        samples.push({
          model,
          prompt_id: prompt.id,
          trial,
          ttft_ms: r.ttft_ms,
          total_ms: r.total_ms,
          output_chars: r.text.length,
          response: r.text,
          error: r.error,
        });
        if (r.error) {
          console.log(`FAIL: ${r.error}`);
        } else {
          console.log(`ttft=${r.ttft_ms}ms total=${r.total_ms}ms chars=${r.text.length}`);
        }
        // small gap so we don't hammer the API
        await new Promise((res) => setTimeout(res, 300));
      }
    }
  }

  // Resolve subproject root: scripts/e1.5/gemini-bench.ts -> ../..
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outPath = join(
    repoRoot,
    'docs/experiments/2026-05-28-e1.5-gemini-model-pick/data',
    'gemini-bench.json',
  );
  writeFileSync(outPath, JSON.stringify(samples, null, 2));
  console.log(`\nwrote ${outPath}  (${samples.length} samples)`);

  // Quick aggregate
  for (const model of MODELS) {
    const m = samples.filter((s) => s.model === model && !s.error);
    if (m.length === 0) {
      console.log(`${model}: no successful samples`);
      continue;
    }
    const ttfts = m.map((s) => s.ttft_ms).filter((x): x is number => x !== null);
    const totals = m.map((s) => s.total_ms);
    const chars = m.map((s) => s.output_chars);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `${model.padEnd(28)}  ttft=${Math.round(mean(ttfts))}ms  total=${Math.round(mean(totals))}ms  out=${Math.round(mean(chars))} chars  (n=${m.length})`,
    );
  }
}

main().catch((err) => {
  console.error('bench fatal:', err);
  process.exit(1);
});

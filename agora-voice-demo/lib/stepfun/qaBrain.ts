import { createGeminiCompletion } from '@/lib/orchestrator/gemini-client';
import type { ChatMessage } from './client';

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL ??
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = process.env.STEPFUN_QA_GEMINI_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';

function geminiKey() {
  return process.env.GOOGLE_API_KEY ?? '';
}

function promptFromMessages(messages: ChatMessage[]) {
  return messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join('\n\n');
}

export function shouldUseGeminiQaBrain() {
  return (process.env.STEPFUN_QA_LLM ?? 'gemini').toLowerCase() !== 'stepfun' && !!geminiKey();
}

export async function completeQa(messages: ChatMessage[]) {
  if (!shouldUseGeminiQaBrain()) return null;
  const llm = createGeminiCompletion({
    apiKey: geminiKey(),
    model: GEMINI_MODEL,
    baseUrl: GEMINI_BASE_URL,
    temperature: 0,
    maxTokens: 120,
  });
  return (await llm(promptFromMessages(messages))).trim();
}

export async function* streamQa(messages: ChatMessage[]): AsyncGenerator<string, void, unknown> {
  if (!shouldUseGeminiQaBrain()) return;
  const res = await fetch(GEMINI_BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${geminiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages,
      stream: true,
      temperature: 0,
      max_tokens: 120,
      reasoning_effort: 'minimal',
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`geminiQaStream ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
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
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Ignore keep-alives / malformed partial chunks.
      }
    }
  }
}

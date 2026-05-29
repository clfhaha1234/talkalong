// lib/orchestrator/gemini-client.ts
//
// Thin OpenAI-compatible Gemini wrapper. E1.5 mandated reasoning_effort='minimal'
// for thinking-capable Gemini variants — without it TTFT goes from ~700ms to
// ~2.5s and output gets truncated at finish_reason='length'. We bake the
// setting in here so bridge and rescript can't accidentally omit it.

export interface GeminiClientOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export type LlmFn = (prompt: string) => Promise<string>;

export function createGeminiCompletion(opts: GeminiClientOpts): LlmFn {
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 1024;
  return async (prompt: string) => {
    const body = {
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature,
      max_tokens: maxTokens,
      reasoning_effort: 'minimal',
    };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data: ')) continue;
        const payload = t.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const c = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = c.choices?.[0]?.delta?.content;
          if (delta) text += delta;
        } catch {
          // ignore non-JSON SSE chunks (keep-alives, etc.)
        }
      }
    }
    return text;
  };
}

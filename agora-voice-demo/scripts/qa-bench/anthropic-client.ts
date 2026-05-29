// Minimal Anthropic chat client for the QA bench. Used as a "stronger
// instruction-follower" proxy for gpt-5-mini when we don't have a direct
// OpenAI key in env. The bench measures prompt quality, so any frontier-class
// model produces a useful signal about whether baseline prompts hold up.

import type { LlmFn } from '../../lib/orchestrator/gemini-client';

export interface AnthropicClientOpts {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export function createAnthropicCompletion(opts: AnthropicClientOpts): LlmFn {
  return async (prompt: string) => {
    const body = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.7,
      messages: [{ role: 'user', content: prompt }],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`anthropic ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim();
    return text;
  };
}

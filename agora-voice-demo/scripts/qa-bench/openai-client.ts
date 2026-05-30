// Minimal OpenAI chat-completions client (non-streaming for simplicity — QA
// answers are short). Mirrors LlmFn so it's a drop-in for createGeminiCompletion.

import type { LlmFn } from '../../lib/orchestrator/gemini-client';

export interface OpenAIClientOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  // Azure OpenAI uses `api-key:` instead of `Authorization: Bearer`. The
  // baseUrl for Azure looks like `https://<resource>.openai.azure.com/openai/v1`
  // and chat-completions appends `/chat/completions` to that.
  authMode?: 'bearer' | 'azure';
}

export function createOpenAICompletion(opts: OpenAIClientOpts): LlmFn {
  const base = opts.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
  // Azure baseUrl is typically the v1 root (no /chat/completions suffix).
  // Auto-append if it looks like the Azure root.
  const url = (opts.authMode === 'azure' && !base.endsWith('/chat/completions'))
    ? base.replace(/\/+$/, '') + '/chat/completions'
    : base;
  // gpt-5 series ignores `temperature` / accept only default; gpt-4 series honors it.
  const isGpt5 = /^gpt-5/i.test(opts.model);
  return async (prompt: string) => {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
    };
    if (!isGpt5 && opts.temperature !== undefined) body.temperature = opts.temperature;
    if (isGpt5) {
      // gpt-5 reasoning models eat the token budget on chain-of-thought when
      // reasoning_effort is left at default. Force minimal so QA answers
      // actually surface within a few hundred tokens.
      body.reasoning_effort = 'minimal';
    }
    if (opts.maxTokens !== undefined) {
      // gpt-5 uses max_completion_tokens; gpt-4 uses max_tokens. Bump the cap
      // for gpt-5 so any residual reasoning + the answer fit.
      body[isGpt5 ? 'max_completion_tokens' : 'max_tokens'] =
        isGpt5 ? Math.max(opts.maxTokens, 2048) : opts.maxTokens;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.authMode === 'azure') {
      headers['api-key'] = opts.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${opts.apiKey}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`openai ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return text.trim();
  };
}

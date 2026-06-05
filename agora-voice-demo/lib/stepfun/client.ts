// StepFun (阶跃星辰) API client — server-side only.
//
// All three generation modalities the storybook tutor needs, mapped onto
// StepFun's OpenAI-shaped endpoints (https://api.stepfun.ai/v1). The key is
// read from STEPFUN_API_KEY and must NEVER reach the browser — every call in
// here runs server-side (route handlers), and the realtime ASR/TTS streams are
// relayed through our own server too.
//
// Verified live 2026-06-05 with the provided key:
//   - chat  step-3.7-flash       → REQUIRES reasoning_effort:'low' or the model
//                                    reasons until it burns max_tokens → empty content.
//   - image step-image-edit-2    → /v1/images/generations returns a url or b64.
//   - tts   step-tts-2           → /v1/audio/speech returns binary mp3.

const BASE = process.env.STEPFUN_BASE_URL ?? 'https://api.stepfun.ai/v1';

function apiKey(): string {
  const k = process.env.STEPFUN_API_KEY;
  if (!k) throw new Error('STEPFUN_API_KEY is not set');
  return k;
}

function authHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${apiKey()}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  /** step-3.7-flash is a reasoning model — default 'low' so it answers directly
   *  instead of spending the whole token budget thinking. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Non-streaming chat completion → the assistant's text. */
export async function stepChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model ?? 'step-3.7-flash',
      messages,
      reasoning_effort: opts.reasoningEffort ?? 'low',
      // step-3.7-flash reasons internally BEFORE emitting content (even at
      // effort:'low' a one-word answer burned ~200 tokens). Too small a budget →
      // the reasoning fills it and `content` comes back EMPTY (finish:length).
      // Default generously so reasoning + the actual answer both fit.
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`stepChat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

export interface ImageOptions {
  model?: string;
  /** One of StepFun's allowed sizes (height×width). Landscape storybook default. */
  size?: '1024x1024' | '1360x768' | '768x1360' | '896x1184' | '1184x896';
  responseFormat?: 'url' | 'b64_json';
  seed?: number;
  signal?: AbortSignal;
}

/** Text-to-image → a URL (default) or base64 JPEG/PNG string. */
export async function stepImage(prompt: string, opts: ImageOptions = {}): Promise<string> {
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: authHeaders(),
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model ?? 'step-image-edit-2',
      prompt: prompt.slice(0, 512), // StepFun caps prompt at 512 chars
      size: opts.size ?? '1360x768',
      response_format: opts.responseFormat ?? 'url',
      ...(opts.seed != null ? { seed: opts.seed } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`stepImage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = data.data?.[0];
  const out = first?.url ?? first?.b64_json;
  if (!out) throw new Error('stepImage: no url/b64 in response');
  return out;
}

export interface TtsOptions {
  model?: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'flac' | 'pcm';
  speed?: number;
  signal?: AbortSignal;
}

/** Non-streaming TTS → an audio Buffer (mp3 by default). StepFun caps input at
 *  1000 chars/call, so callers should chunk long narration. */
export async function stepTTS(input: string, opts: TtsOptions = {}): Promise<Buffer> {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: authHeaders(),
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model ?? 'step-tts-2',
      input: input.slice(0, 1000),
      voice: opts.voice ?? 'lively-girl',
      response_format: opts.format ?? 'mp3',
      ...(opts.speed != null ? { speed: opts.speed } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`stepTTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGeminiCompletion } from './gemini-client';

describe('gemini client', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends a streaming chat-completion with reasoning_effort=minimal', async () => {
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = init.body;
      // Minimal valid SSE response
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`));
          controller.enqueue(enc.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const llm = createGeminiCompletion({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    const out = await llm('say hello');
    expect(out).toBe('hello');
    expect(capturedBody).toContain('"reasoning_effort":"minimal"');
    expect(capturedBody).toContain('gemini-3.1-flash-lite');
  });

  it('throws on non-200 response', async () => {
    global.fetch = vi.fn(async () => new Response('err', { status: 429 })) as unknown as typeof fetch;
    const llm = createGeminiCompletion({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    await expect(llm('x')).rejects.toThrow(/429/);
  });
});

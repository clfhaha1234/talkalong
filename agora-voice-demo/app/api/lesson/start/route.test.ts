import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { NextRequest } from 'next/server';

beforeEach(() => {
  process.env.NEXT_PUBLIC_AGORA_APP_ID = 'a';
  process.env.NEXT_AGORA_APP_CERTIFICATE = 'b';
});

function mkReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/lesson/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/lesson/start — validation', () => {
  it('returns 400 on missing input_text', async () => {
    const res = await POST(mkReq({}));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/input_text/);
  });

  it('returns 400 on empty input_text', async () => {
    const res = await POST(mkReq({ input_text: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on oversized input_text', async () => {
    const res = await POST(mkReq({ input_text: 'a'.repeat(8001) }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/lesson/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

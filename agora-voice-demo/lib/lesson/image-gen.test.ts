import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateSceneImage, generateScenesParallel } from './image-gen';
import { buildScenePrompt } from './style-prompt';

let tmpCacheDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpCacheDir = mkdtempSync(join(tmpdir(), 'imagegen-test-'));
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  rmSync(tmpCacheDir, { recursive: true, force: true });
});

function fakeImageResponse(b64 = 'AAAA'): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/jpeg', data: b64 } }],
          },
        },
      ],
    }),
    { status: 200 },
  );
}

describe('generateSceneImage', () => {
  it('cache miss → fetches, writes file, returns cached: false', async () => {
    const fetchMock = vi.fn(async () => fakeImageResponse('SGVsbG8=')); // "Hello"
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await generateSceneImage('a quiet child', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });

    expect(r.cached).toBe(false);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.bytes).toBe(5); // "Hello" decoded is 5 bytes
    // file_path is set on the fs path (this test). It's optional on the type
    // because the Vercel Blob path returns a Blob URL instead.
    expect(r.file_path).toBeDefined();
    expect(existsSync(r.file_path!)).toBe(true);
    expect(readFileSync(r.file_path!).toString('utf8')).toBe('Hello');
    expect(r.url).toBe(`/lesson-cache/${r.hash}.jpg`);
    expect(r.hash).toHaveLength(16);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache hit → no fetch, cached: true, latency_ms = 0', async () => {
    const fetchMock = vi.fn(async () => fakeImageResponse('SGVsbG8='));
    global.fetch = fetchMock as unknown as typeof fetch;

    await generateSceneImage('a quiet child', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });
    fetchMock.mockClear();

    const r = await generateSceneImage('a quiet child', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });

    expect(r.cached).toBe(true);
    expect(r.latency_ms).toBe(0);
    expect(r.bytes).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hash is stable for identical scene descriptions', async () => {
    const fetchMock = vi.fn(async () => fakeImageResponse('SGVsbG8='));
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await generateSceneImage('a quiet child', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });
    const otherCacheDir = mkdtempSync(join(tmpdir(), 'imagegen-test-other-'));
    try {
      const b = await generateSceneImage('a quiet child', {
        api_key: 'k',
        cache_dir: otherCacheDir,
      });
      expect(b.hash).toBe(a.hash);
    } finally {
      rmSync(otherCacheDir, { recursive: true, force: true });
    }
  });

  it('different scene descriptions produce different hashes', async () => {
    global.fetch = vi.fn(async () => fakeImageResponse('SGVsbG8=')) as unknown as typeof fetch;

    const a = await generateSceneImage('scene one', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });
    const b = await generateSceneImage('scene two', {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it('no inlineData → throws (safety reject)', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'safety reject' }] } }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      generateSceneImage('x', { api_key: 'k', cache_dir: tmpCacheDir }),
    ).rejects.toThrow(/no inlineData/);
  });

  it('non-200 HTTP → throws with status', async () => {
    global.fetch = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      generateSceneImage('x', { api_key: 'k', cache_dir: tmpCacheDir }),
    ).rejects.toThrow(/429/);
  });

  it('cache key matches sha256(buildScenePrompt(scene)).slice(0, 16)', async () => {
    global.fetch = vi.fn(async () => fakeImageResponse('SGVsbG8=')) as unknown as typeof fetch;
    const scene = 'a curious sparrow on a fence';
    const r = await generateSceneImage(scene, {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });

    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(buildScenePrompt(scene)).digest('hex').slice(0, 16);
    expect(r.hash).toBe(expected);
  });
});

describe('generateScenesParallel', () => {
  it('returns same order as input', async () => {
    global.fetch = vi.fn(async () => fakeImageResponse('SGVsbG8=')) as unknown as typeof fetch;

    const out = await generateScenesParallel(['alpha', 'beta', 'gamma'], {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });

    expect(out).toHaveLength(3);
    expect('error' in out[0]).toBe(false);
    expect('error' in out[1]).toBe(false);
    expect('error' in out[2]).toBe(false);

    // Hashes correspond to input order.
    const { createHash } = await import('node:crypto');
    const expected0 = createHash('sha256').update(buildScenePrompt('alpha')).digest('hex').slice(0, 16);
    expect((out[0] as { hash: string }).hash).toBe(expected0);
  });

  it('partial failures surfaced per item; other items succeed', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 2) return new Response('boom', { status: 500 });
      return fakeImageResponse('SGVsbG8=');
    }) as unknown as typeof fetch;

    const out = await generateScenesParallel(['a', 'b', 'c'], {
      api_key: 'k',
      cache_dir: tmpCacheDir,
    });

    expect(out).toHaveLength(3);
    expect('error' in out[0]).toBe(false);
    expect('error' in out[1]).toBe(true);
    expect('error' in out[2]).toBe(false);
    // Failed item carries the original scene description for caller context.
    expect((out[1] as { sceneDescription: string }).sceneDescription).toBe('b');
  });
});

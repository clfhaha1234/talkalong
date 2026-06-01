// Image-generation library for storybook scenes.
//
// Why: latency is the dominant UX risk for this feature — cold start ~51s,
// warm 10-25s per image. We address this two ways:
//   1. Parallel generation of scenes via Promise.allSettled.
//   2. Content-addressed caching: the cache key is sha256 of the full prompt
//      (style template + scene). Same prompt → same key → byte-identical hit.
//
// Cache lives under `public/lesson-cache/{hash}.jpg`, so Next.js serves the
// file automatically at `/lesson-cache/{hash}.jpg` with zero extra wiring.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildScenePrompt } from './style-prompt';

export interface ImageGenResult {
  /** sha256(prompt).slice(0, 16) — the cache key. 16 hex chars = 64 bits, plenty for this scale. */
  hash: string;
  /** Absolute URL path the browser loads. */
  url: string;
  /** Server-side absolute file path of the cached image. Absent on the Vercel
   *  Blob path (the image lives in Blob storage, not the local FS). */
  file_path?: string;
  /** True if served from cache, false if freshly generated. */
  cached: boolean;
  /** Milliseconds — 0 for cache hits, real wall-clock for generation. */
  latency_ms: number;
  /** Image byte count. Only set for fresh generations; omitted for cache hits to save memory. */
  bytes?: number;
}

export interface ImageGenOptions {
  /** Defaults to env GOOGLE_API_KEY. */
  api_key?: string;
  /** Defaults to 'gemini-3.1-flash-image'. */
  model?: string;
  /** Defaults to <cwd>/public/lesson-cache. */
  cache_dir?: string;
}

const DEFAULT_MODEL = 'gemini-3.1-flash-image';

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        text?: string;
      }>;
    };
  }>;
}

function defaultCacheDir(): string {
  if (process.env.LESSON_CACHE_DIR) return process.env.LESSON_CACHE_DIR;
  return join(process.cwd(), 'public', 'lesson-cache');
}

function ensureCacheDir(dir: string): void {
  // `recursive: true` means we don't crash if the directory already exists.
  mkdirSync(dir, { recursive: true });
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

/**
 * Generate ONE scene image. Hits cache by content hash; on miss, calls the
 * Gemini Image API and writes the result to the cache dir.
 *
 * Throws if the API response carries no `inlineData` (e.g., safety filter
 * rejection or HTTP failure) so the caller can decide between retry, error
 * surface, or placeholder image.
 */
/** Call Gemini once and return the raw JPEG bytes (+ latency). Throws on HTTP
 *  failure or a safety-rejected (no inlineData) response. */
async function fetchSceneImageBytes(
  prompt: string,
  apiKey: string,
  model: string,
): Promise<{ buf: Buffer; latencyMs: number }> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const startedAt = Date.now();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `generateSceneImage: Gemini HTTP ${res.status} after ${Date.now() - startedAt}ms — ${errText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as GeminiImageResponse;
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const inlineData = parts.find((p) => p.inlineData)?.inlineData;
  const text = parts.find((p) => p.text)?.text;

  if (!inlineData?.data) {
    const detail = text ? ` text="${text.slice(0, 200)}"` : '';
    throw new Error(
      `generateSceneImage: no inlineData in response (likely safety reject).${detail}`,
    );
  }

  return { buf: Buffer.from(inlineData.data, 'base64'), latencyMs: Date.now() - startedAt };
}

export async function generateSceneImage(
  sceneDescription: string,
  opts: ImageGenOptions = {},
): Promise<ImageGenResult> {
  const apiKey = opts.api_key ?? process.env.GOOGLE_API_KEY;
  const model = opts.model ?? DEFAULT_MODEL;
  const prompt = buildScenePrompt(sceneDescription);
  const hash = hashPrompt(prompt);

  // On Vercel, public/ is read-only AND runtime-written files aren't served by
  // the CDN — so the filesystem cache can't work. When a Blob store is wired
  // (BLOB_READ_WRITE_TOKEN present), upload the generated image to Vercel Blob
  // and return its CDN URL. The deterministic pathname + allowOverwrite makes
  // re-puts idempotent. Locally / on a persistent host the fs path below runs.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    if (!apiKey) {
      throw new Error('generateSceneImage: api_key is required (set GOOGLE_API_KEY or pass opts.api_key)');
    }
    const { buf, latencyMs } = await fetchSceneImageBytes(prompt, apiKey, model);
    const { put } = await import('@vercel/blob');
    const blob = await put(`lesson-cache/${hash}.jpg`, buf, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'image/jpeg',
    });
    return { hash, url: blob.url, cached: false, latency_ms: latencyMs, bytes: buf.length };
  }

  // Filesystem path (local dev / persistent host): cache on disk, served via
  // the /api/lesson-image/<hash> route — NOT the static /lesson-cache/ path.
  // `next start` (production, e.g. Render) does NOT serve public/ files written
  // AFTER the build, so the static path 404s in prod; the route reads the file
  // from disk per request and works regardless of when it was written.
  const cacheDir = opts.cache_dir ?? defaultCacheDir();
  ensureCacheDir(cacheDir);
  const filePath = join(cacheDir, `${hash}.jpg`);
  const url = `/api/lesson-image/${hash}`;

  if (existsSync(filePath)) {
    return { hash, url, file_path: filePath, cached: true, latency_ms: 0 };
  }

  if (!apiKey) {
    throw new Error('generateSceneImage: api_key is required (set GOOGLE_API_KEY or pass opts.api_key)');
  }

  const { buf, latencyMs } = await fetchSceneImageBytes(prompt, apiKey, model);
  writeFileSync(filePath, buf);

  return {
    hash,
    url,
    file_path: filePath,
    cached: false,
    latency_ms: latencyMs,
    bytes: buf.length,
  };
}

/**
 * Generate MANY scenes in parallel. Returns results in the same order as the
 * input array. Per-scene failures are surfaced as `{ error, sceneDescription }`
 * objects instead of failing the whole batch — one safety-rejected scene
 * shouldn't block the others.
 */
export async function generateScenesParallel(
  sceneDescriptions: string[],
  opts: ImageGenOptions = {},
): Promise<Array<ImageGenResult | { error: string; sceneDescription: string }>> {
  const settled = await Promise.allSettled(
    sceneDescriptions.map((scene) => generateSceneImage(scene, opts)),
  );

  return settled.map((result, idx) => {
    if (result.status === 'fulfilled') return result.value;
    const reason = result.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    return { error: msg, sceneDescription: sceneDescriptions[idx] };
  });
}

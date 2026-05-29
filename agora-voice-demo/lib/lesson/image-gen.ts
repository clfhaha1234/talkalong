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
  /** Server-side absolute file path of the cached image. */
  file_path: string;
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
export async function generateSceneImage(
  sceneDescription: string,
  opts: ImageGenOptions = {},
): Promise<ImageGenResult> {
  const apiKey = opts.api_key ?? process.env.GOOGLE_API_KEY;
  const model = opts.model ?? DEFAULT_MODEL;
  const cacheDir = opts.cache_dir ?? defaultCacheDir();

  ensureCacheDir(cacheDir);

  const prompt = buildScenePrompt(sceneDescription);
  const hash = hashPrompt(prompt);
  const filePath = join(cacheDir, `${hash}.jpg`);
  const url = `/lesson-cache/${hash}.jpg`;

  // Cache HIT — return immediately. We deliberately do not read the file
  // bytes off disk; the caller has the URL/path and the browser will fetch
  // the static asset directly via Next.js.
  if (existsSync(filePath)) {
    return {
      hash,
      url,
      file_path: filePath,
      cached: true,
      latency_ms: 0,
    };
  }

  // Cache MISS — call Gemini.
  if (!apiKey) {
    throw new Error('generateSceneImage: api_key is required (set GOOGLE_API_KEY or pass opts.api_key)');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const startedAt = Date.now();

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
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

  const buf = Buffer.from(inlineData.data, 'base64');
  writeFileSync(filePath, buf);
  const latencyMs = Date.now() - startedAt;

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

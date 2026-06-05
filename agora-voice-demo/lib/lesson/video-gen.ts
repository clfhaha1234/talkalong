// Scene video-generation library.
//
// Turns a storybook scene's still illustration into an animated 10s clip by
// driving the parent Remotion project (../) as a subprocess: first
// `preprocess.ts` (sharp → potrace traces the line art, samples a paper bg),
// then `remotion render BookPage` (pencil strokes draw on, watercolor fades
// in, slow Ken Burns + breathing, hold on the last frame).
//
// We can't import the parent project directly — it's React 18 / Remotion and
// this app is React 19 / Next 16. So the boundary is a CLI subprocess.
//
// Caching mirrors image-gen: the cache key IS the image's content hash (the
// {hash}.jpg filename), so the same illustration never re-renders. Output
// lands at {LESSON_CACHE_DIR}/videos/{hash}.mp4 (or public/lesson-cache/videos
// locally) and is served through /api/lesson-video/{hash}. `next start` does not
// serve runtime-written public/ files on Render, so a route is required.
//
// Always fails soft: on any error (preprocess/render crash, timeout, missing
// source) we return { error } and the caller keeps showing the static image.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface VideoGenResult {
  hash: string;
  /** Browser URL path, e.g. /api/lesson-video/abc123 */
  url: string;
  file_path: string;
  cached: boolean;
  latency_ms: number;
}

export interface VideoGenError {
  error: string;
}

export interface VideoGenOptions {
  /** App root (where public/ lives). Defaults to process.cwd(). */
  appRoot?: string;
  /** Parent Remotion project dir. Defaults to <appRoot>/.. */
  parentProjectDir?: string;
  /** Hard cap for preprocess + render combined. Default 120s. */
  budget_ms?: number;
}

const DEFAULT_BUDGET_MS = 120_000;

// Remotion rendering is heavy enough to OOM a 512MB Render Starter web
// instance if two lesson sessions launch Chromium at the same time. Keep this
// process-wide and fail soft under load; the lesson keeps the static image.
let activeRenderHash: string | null = null;

function cacheRoot(appRoot: string): string {
  return process.env.LESSON_CACHE_DIR ?? join(appRoot, 'public', 'lesson-cache');
}

/** Derive the image content hash from /api/lesson-image/abc123 or /lesson-cache/abc123.jpg. */
function hashFromImageUrl(imageUrl: string): string {
  const pathname = imageUrl.startsWith('http')
    ? new URL(imageUrl).pathname
    : imageUrl;
  const base = pathname.split('/').pop() ?? '';
  return base.replace(/\.[a-z0-9]+$/i, '');
}

/** Map a generated image URL to its on-disk cache path. */
function imageFilePath(appRoot: string, imageUrl: string, hash: string): string {
  const pathname = imageUrl.startsWith('http')
    ? new URL(imageUrl).pathname
    : imageUrl;
  if (pathname.startsWith('/api/lesson-image/')) {
    return join(cacheRoot(appRoot), `${hash}.jpg`);
  }
  // Back-compat for older callers/tests that still pass the static dev path.
  const rel = pathname.replace(/^\/+/, '');
  return join(appRoot, 'public', rel);
}

/** Deterministic non-zero seed from the content hash so re-renders match. */
function seedFromHash(hash: string): number {
  const n = parseInt(hash.slice(0, 8), 16);
  return (Number.isFinite(n) ? n : 1) % 0x7fffffff || 1;
}

/**
 * Render ONE scene's illustration into an animated mp4. Cache-keyed by the
 * image's content hash. Returns the existing clip instantly on a cache hit.
 *
 * @param imageUrl  the scene's image_url (e.g. /api/lesson-image/{hash})
 */
export async function generateSceneVideo(
  imageUrl: string,
  opts: VideoGenOptions = {},
): Promise<VideoGenResult | VideoGenError> {
  const appRoot = opts.appRoot ?? process.cwd();
  const parentDir = opts.parentProjectDir ?? resolve(appRoot, '..');
  const budgetMs = opts.budget_ms ?? DEFAULT_BUDGET_MS;
  const t0 = Date.now();

  const hash = hashFromImageUrl(imageUrl);
  if (!hash) return { error: `cannot derive hash from imageUrl=${imageUrl}` };

  const videosDir = join(cacheRoot(appRoot), 'videos');
  const outMp4 = join(videosDir, `${hash}.mp4`);
  const url = `/api/lesson-video/${hash}`;

  // Cache HIT.
  if (existsSync(outMp4)) {
    return { hash, url, file_path: outMp4, cached: true, latency_ms: 0 };
  }

  const srcImage = imageFilePath(appRoot, imageUrl, hash);
  if (!existsSync(srcImage)) {
    return { error: `source image not found: ${srcImage}` };
  }

  const preprocessScript = join(parentDir, 'src', 'preprocess.ts');
  if (!existsSync(preprocessScript)) {
    return {
      error: `video renderer unavailable: ${preprocessScript} not found`,
    };
  }

  if (activeRenderHash) {
    return { error: `video renderer busy rendering ${activeRenderHash}; keeping static image` };
  }
  activeRenderHash = hash;

  mkdirSync(videosDir, { recursive: true });

  // Preprocess + render scratch lives under the PARENT project's public/ so
  // Remotion's staticFile() can resolve the lines/color/meta relative paths.
  const renderSubrel = `lesson-cache/render/${hash}`; // relative to parent/public
  const absSrcImage = isAbsolute(srcImage) ? srcImage : resolve(appRoot, srcImage);

  try {
    // 1. preprocess → parent/public/lesson-cache/render/{hash}/{lines.svg,color.png,meta.json}
    console.log(`[video-gen] preprocess start hash=${hash}`);
    await execFileAsync(
      'npx',
      ['tsx', 'src/preprocess.ts', absSrcImage, '--out-dir', `public/${renderSubrel}`],
      { cwd: parentDir, timeout: Math.floor(budgetMs / 2), maxBuffer: 8 * 1024 * 1024 },
    );

    // 2. render → absolute mp4 path in THIS app's public/videos.
    const props = JSON.stringify({
      linesSvgPath: `${renderSubrel}/lines.svg`,
      colorImagePath: `${renderSubrel}/color.png`,
      metaPath: `${renderSubrel}/meta.json`,
      seed: seedFromHash(hash),
      bgColor: '',
    });
    console.log(`[video-gen] render start hash=${hash} out=${outMp4}`);
    await execFileAsync(
      'npx',
      [
        'remotion',
        'render',
        'src/index.ts',
        'BookPage',
        outMp4,
        `--props=${props}`,
        '--concurrency=1',
        '--codec=h264',
        '--crf=28',
      ],
      { cwd: parentDir, timeout: budgetMs, maxBuffer: 16 * 1024 * 1024 },
    );

    if (!existsSync(outMp4)) {
      return { error: 'render reported success but no mp4 was written' };
    }
    console.log(`[video-gen] render done hash=${hash} latency_ms=${Date.now() - t0}`);
    return { hash, url, file_path: outMp4, cached: false, latency_ms: Date.now() - t0 };
  } catch (err) {
    console.warn(`[video-gen] render failed hash=${hash}: ${(err as Error).message}`);
    return { error: `video render failed: ${(err as Error).message.slice(0, 300)}` };
  } finally {
    activeRenderHash = null;
  }
}

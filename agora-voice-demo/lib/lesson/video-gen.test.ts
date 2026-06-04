import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSceneVideo } from './video-gen';

describe('generateSceneVideo', () => {
  let appRoot: string;
  let oldLessonCacheDir: string | undefined;

  beforeEach(() => {
    oldLessonCacheDir = process.env.LESSON_CACHE_DIR;
    delete process.env.LESSON_CACHE_DIR;
    appRoot = mkdtempSync(join(tmpdir(), 'video-gen-'));
  });
  afterEach(() => {
    if (oldLessonCacheDir === undefined) {
      delete process.env.LESSON_CACHE_DIR;
    } else {
      process.env.LESSON_CACHE_DIR = oldLessonCacheDir;
    }
    rmSync(appRoot, { recursive: true, force: true });
  });

  it('returns cached result instantly when the mp4 already exists', async () => {
    const videosDir = join(appRoot, 'public', 'lesson-cache', 'videos');
    mkdirSync(videosDir, { recursive: true });
    writeFileSync(join(videosDir, 'deadbeef0badf00d.mp4'), 'fake-mp4-bytes');

    const res = await generateSceneVideo('/lesson-cache/deadbeef0badf00d.jpg', { appRoot });
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.cached).toBe(true);
      expect(res.hash).toBe('deadbeef0badf00d');
      expect(res.url).toBe('/api/lesson-video/deadbeef0badf00d');
      expect(res.latency_ms).toBe(0);
    }
  });

  it('resolves /api/lesson-image sources from LESSON_CACHE_DIR on persistent hosts', async () => {
    const cacheDir = join(appRoot, 'cache');
    process.env.LESSON_CACHE_DIR = cacheDir;
    const videosDir = join(cacheDir, 'videos');
    mkdirSync(videosDir, { recursive: true });
    writeFileSync(join(videosDir, 'feedface12345678.mp4'), 'fake-mp4-bytes');

    const res = await generateSceneVideo('/api/lesson-image/feedface12345678', { appRoot });
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.cached).toBe(true);
      expect(res.file_path).toBe(join(videosDir, 'feedface12345678.mp4'));
      expect(res.url).toBe('/api/lesson-video/feedface12345678');
    }
  });

  it('errors (does not throw) when the source image is missing and no cache exists', async () => {
    const res = await generateSceneVideo('/lesson-cache/missing123.jpg', { appRoot });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toMatch(/source image not found/);
    }
  });

  it('errors on an unparseable image url', async () => {
    const res = await generateSceneVideo('/', { appRoot });
    expect('error' in res).toBe(true);
  });
});

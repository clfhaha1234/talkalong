import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSceneVideo } from './video-gen';

describe('generateSceneVideo', () => {
  let appRoot: string;
  let oldLessonCacheDir: string | undefined;
  let oldLessonVideoRendering: string | undefined;

  beforeEach(() => {
    oldLessonCacheDir = process.env.LESSON_CACHE_DIR;
    oldLessonVideoRendering = process.env.LESSON_VIDEO_RENDERING;
    delete process.env.LESSON_CACHE_DIR;
    process.env.LESSON_VIDEO_RENDERING = '1';
    appRoot = mkdtempSync(join(tmpdir(), 'video-gen-'));
  });
  afterEach(() => {
    if (oldLessonCacheDir === undefined) {
      delete process.env.LESSON_CACHE_DIR;
    } else {
      process.env.LESSON_CACHE_DIR = oldLessonCacheDir;
    }
    if (oldLessonVideoRendering === undefined) {
      delete process.env.LESSON_VIDEO_RENDERING;
    } else {
      process.env.LESSON_VIDEO_RENDERING = oldLessonVideoRendering;
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

  it('fails soft when runtime video rendering is disabled', async () => {
    delete process.env.LESSON_VIDEO_RENDERING;
    const imageDir = join(appRoot, 'public', 'lesson-cache');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'decafbad12345678.jpg'), 'fake-jpg-bytes');

    const res = await generateSceneVideo('/lesson-cache/decafbad12345678.jpg', { appRoot });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toMatch(/video rendering disabled/);
    }
  });

  it('errors (does not throw) when the source image is missing and no cache exists', async () => {
    const res = await generateSceneVideo('/lesson-cache/missing123.jpg', { appRoot });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toMatch(/source image not found/);
    }
  });

  it('fails fast when the Remotion parent project is not present in the deployment', async () => {
    const imageDir = join(appRoot, 'public', 'lesson-cache');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'cafebabefeed1234.jpg'), 'fake-jpg-bytes');

    const res = await generateSceneVideo('/lesson-cache/cafebabefeed1234.jpg', {
      appRoot,
      parentProjectDir: join(appRoot, 'missing-parent'),
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error).toMatch(/video renderer unavailable/);
    }
  });

  it('errors on an unparseable image url', async () => {
    const res = await generateSceneVideo('/', { appRoot });
    expect('error' in res).toBe(true);
  });
});

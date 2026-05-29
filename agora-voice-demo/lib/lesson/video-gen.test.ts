import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSceneVideo } from './video-gen';

describe('generateSceneVideo', () => {
  let appRoot: string;

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), 'video-gen-'));
  });
  afterEach(() => {
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
      expect(res.url).toBe('/lesson-cache/videos/deadbeef0badf00d.mp4');
      expect(res.latency_ms).toBe(0);
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

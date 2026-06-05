// Cache a StepFun-generated illustration (a remote OSS URL) onto local disk so
// the Remotion video pipeline can find it. video-gen.ts keys everything off the
// image's content hash and reads public/lesson-cache/{hash}.jpg, serving it via
// /api/lesson-image/{hash} (the route that works under `next start` too). A raw
// remote OSS URL can't feed that pipeline (and can expire), so we pull the bytes
// down once and hand back the local, content-addressed URL.
//
// Fail-soft: on any download/write error we return the original remote URL and
// an empty hash — the lesson still renders the picture, it just won't get a
// video for that scene.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function cacheDir(): string {
  return process.env.LESSON_CACHE_DIR ?? join(process.cwd(), 'public', 'lesson-cache');
}

export interface CachedImage {
  /** content hash (16 hex) or '' if caching failed */
  hash: string;
  /** /api/lesson-image/{hash} on success, else the original remote URL */
  url: string;
}

export async function cacheImageToDisk(remoteUrl: string): Promise<CachedImage> {
  if (!remoteUrl) return { hash: '', url: remoteUrl };
  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error(`fetch image ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('image too small');
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${hash}.jpg`);
    if (!existsSync(file)) writeFileSync(file, buf);
    return { hash, url: `/api/lesson-image/${hash}` };
  } catch {
    return { hash: '', url: remoteUrl };
  }
}

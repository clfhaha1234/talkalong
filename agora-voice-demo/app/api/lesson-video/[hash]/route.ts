// Serve runtime-generated lesson animation clips from disk.
//
// Mirrors /api/lesson-image/[hash]: production `next start` on Render will not
// serve files written to public/ after build, so video clips need a dynamic
// route too.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  if (!/^[a-f0-9]{8,40}$/.test(hash)) {
    return new Response('bad video id', { status: 400 });
  }
  const cacheDir = process.env.LESSON_CACHE_DIR ?? join(process.cwd(), 'public', 'lesson-cache');
  const file = join(cacheDir, 'videos', `${hash}.mp4`);
  try {
    const buf = await readFile(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('video not found', { status: 404 });
  }
}

// Serve runtime-generated lesson illustrations from disk.
//
// WHY THIS ROUTE EXISTS: the fs image cache writes JPEGs to
// public/lesson-cache/<hash>.jpg at RUNTIME (during lesson compose). In dev
// (`next dev`) those are served at /lesson-cache/<hash>.jpg, but in PRODUCTION
// (`next start`, i.e. the Render container) Next.js only serves public/ assets
// that existed at BUILD time — files written after the build 404. (On Vercel
// the FS is read-only entirely; that path uses Vercel Blob instead.) So on a
// persistent host the image existed on disk (cached:true) yet the browser got a
// 404 → broken illustration. This route reads the cached file from disk per
// request, which works regardless of when it was written.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ hash: string }> },
) {
  const { hash } = await params;
  // Hash is sha256(prompt).slice(0,16) — hex only. Reject anything else so a
  // crafted param can't traverse the filesystem.
  if (!/^[a-f0-9]{8,40}$/.test(hash)) {
    return new Response('bad image id', { status: 400 });
  }
  const file = join(process.cwd(), 'public', 'lesson-cache', `${hash}.jpg`);
  try {
    const buf = await readFile(file);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        // Content-addressed by hash → safe to cache hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('image not found', { status: 404 });
  }
}

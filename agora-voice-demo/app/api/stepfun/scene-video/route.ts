// Render ONE StepFun storybook scene's illustration into an animated mp4, the
// same way /tutor does — by driving the parent Remotion project as a subprocess
// (lib/lesson/video-gen.ts). The client calls this lazily, one scene at a time,
// after the story is already on screen; each scene swaps its static <img> for a
// <video> when this returns.
//
// Heavy: spawns headless Chromium (~10s/scene, single-concurrency). Gated by
// LESSON_VIDEO_RENDERING=1 (keep it OFF on 512MB hosts to avoid OOM). Fails soft
// — on any error the caller just keeps showing the still image.
import { NextRequest, NextResponse } from 'next/server';
import { generateSceneVideo } from '@/lib/lesson/video-gen';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { imageUrl } = (await req.json()) as { imageUrl?: string };
    if (!imageUrl || !imageUrl.startsWith('/api/lesson-image/')) {
      // Only locally-cached images can be rendered (video-gen needs the file on
      // disk); a remote URL means caching failed upstream → no video.
      return NextResponse.json({ error: 'a cached /api/lesson-image/{hash} url is required' }, { status: 400 });
    }
    const result = await generateSceneVideo(imageUrl);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 200 }); // soft: client keeps the image
    }
    return NextResponse.json({ videoUrl: result.url, cached: result.cached, latencyMs: result.latency_ms });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'scene-video failed' }, { status: 200 });
  }
}

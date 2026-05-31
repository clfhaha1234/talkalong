// POST /api/lesson/start
// Body: { input_text: string }
// Response: text/event-stream (SSE)
//
// Conductor for the storybook lesson flow. Orchestrates three phases over a
// single long-lived SSE stream so the browser can drive its full
// LoadingScreen → StoryScreen → narration journey from one fetch:
//
//   1. Compose      — split input into ~6 scenes via the deterministic
//                     scene composer (fast, < 100 ms).
//   2. Generate     — fire all image generations in parallel; emit per-scene
//                     readiness so the LoadingScreen can render progress.
//   3. Narrate      — once every image has settled (success or failure),
//                     hand off to startTutorSessionFromScenes and forward
//                     every ProgressEvent verbatim.
//
// Event types emitted (in roughly this order):
//   { type: 'script_drafted',     title: string }
//   { type: 'scenes_composed',    scenes: Scene[] }
//   { type: 'image_ready',        scene_id, image_url, cached, latency_ms }
//   { type: 'image_failed',       scene_id, error }
//   { type: 'all_images_ready' }
//   ...forwarded ProgressEvents: session_started, snapshot, segment_started,
//      segment_completed, narration_complete, branch_started, branch_ended,
//      bridge_started, bridge_completed, comprehension_changed, error.

import { NextRequest } from 'next/server';
import { composeLessonAsync } from '@/lib/lesson/script-generator';
import { generateScenesParallel } from '@/lib/lesson/image-gen';
import { generateSceneVideo } from '@/lib/lesson/video-gen';
import { startTutorSessionFromScenes } from '@/lib/orchestrator';
import type { ProgressEvent } from '@/lib/orchestrator';
import type { Scene } from '@/lib/lesson/types';

export const runtime = 'nodejs';
// The SSE holds open for the whole narration. 800s is the hard ceiling on
// Vercel Pro (Fluid Compute) — a typical 3–5 scene story narrates well within
// it. A pathologically long session would be cut off at 800s; on a persistent
// host (see DEPLOY.md) there's no such cap.
export const maxDuration = 800;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export async function POST(req: NextRequest) {
  let body: { input_text?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const text = (body.input_text ?? '').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'input_text is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (text.length > 8000) {
    return new Response(JSON.stringify({ error: 'input_text exceeds 8000 chars' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const agora_app_id = requireEnv('NEXT_PUBLIC_AGORA_APP_ID');
  const agora_app_certificate = requireEnv('NEXT_AGORA_APP_CERTIFICATE');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // Controller closed (client disconnected). Swallow.
        }
      };

      let handle: Awaited<ReturnType<typeof startTutorSessionFromScenes>> | null = null;
      let unsubscribe: (() => void) | null = null;

      try {
        // Phase 1: compose scenes via LLM (Gemini Flash Lite). Cached by
        // content hash so repeats of the same input are instant. Always
        // succeeds — on LLM failure, falls back to the deterministic stub.
        const composed = await composeLessonAsync(text);
        const lesson = composed.lesson;
        send({ type: 'script_drafted', title: lesson.title });
        // Send the full scene list immediately so the client can render the
        // book skeleton — image_url stays undefined until the per-scene
        // image_ready event fills it in.
        send({ type: 'scenes_composed', scenes: lesson.scenes });

        // Phase 2: parallel image generation. We deliberately wrap each scene
        // in its own generateScenesParallel call rather than batching all 6
        // through a single call: this gives us a per-scene completion hook
        // (image_ready / image_failed) which the LoadingScreen renders as
        // progressive feedback. Promise.all here waits for all to settle —
        // per-scene failures are caught and emitted as image_failed, so they
        // never reject the outer Promise.all.
        const promises = lesson.scenes.map(async (scene) => {
          try {
            const [result] = await generateScenesParallel([scene.image_prompt]);
            if ('error' in result) {
              send({ type: 'image_failed', scene_id: scene.id, error: result.error });
              return null;
            }
            scene.image_url = result.url;
            send({
              type: 'image_ready',
              scene_id: scene.id,
              image_url: result.url,
              cached: result.cached,
              latency_ms: result.latency_ms,
            });
            return result;
          } catch (err) {
            send({ type: 'image_failed', scene_id: scene.id, error: (err as Error).message });
            return null;
          }
        });
        await Promise.all(promises);
        send({ type: 'all_images_ready' });

        // Phase 2.5: animate the still illustrations into clips via the parent
        // Remotion project (subprocess). Per the locked design we render ONLY
        // scene 1 synchronously here — it gates entry to the story — then fire
        // scenes 2..N as a detached background loop. Each ~8s render lands a
        // `video_ready` the browser hot-swaps in. Rendering 2..N sequentially
        // (not parallel) avoids spawning several headless-chrome renderers at
        // once; 4 renders (~32s) still finish well before narration (~64s of
        // playback for those scenes) reaches them.
        const renderSceneVideo = async (scene: Scene): Promise<void> => {
          if (!scene.image_url) {
            send({ type: 'video_failed', scene_id: scene.id, error: 'no image_url' });
            return;
          }
          const result = await generateSceneVideo(scene.image_url);
          if ('error' in result) {
            send({ type: 'video_failed', scene_id: scene.id, error: result.error });
            return;
          }
          scene.video_url = result.url;
          send({
            type: 'video_ready',
            scene_id: scene.id,
            video_url: result.url,
            cached: result.cached,
            latency_ms: result.latency_ms,
          });
        };

        const [firstScene, ...restScenes] = lesson.scenes;
        if (firstScene) {
          // Block on scene 1 so the very first page animates from the start.
          await renderSceneVideo(firstScene);
        }
        // Background loop for the rest — deliberately NOT awaited so the
        // session starts immediately. Errors are swallowed into video_failed.
        void (async () => {
          for (const scene of restScenes) {
            await renderSceneVideo(scene);
          }
          send({ type: 'all_videos_ready' });
        })();

        // Phase 3: kick off the Agora narration session. We start this AFTER
        // emitting all_images_ready (and scene-1 video) so the browser has a
        // clear cue to transition from LoadingScreen → StoryScreen.
        handle = await startTutorSessionFromScenes({
          scenes: lesson.scenes,
          config: {
            agora_app_id,
            agora_app_certificate,
            // Pass the detected language down so TTS voice / STT language /
            // agent persona all match the script the listener will hear.
            // Falls back to English if the script-generator didn't detect
            // (older cache hits or the deterministic-fallback path).
            language: lesson.language,
          },
        });

        // Subscribe BEFORE startNarration so the first session_started event
        // (which startNarration emits) is captured.
        unsubscribe = handle.progress.subscribe((e: ProgressEvent) => send(e));
        await handle.startNarration();
      } catch (err) {
        send({ type: 'error', message: (err as Error).message });
      } finally {
        if (unsubscribe) unsubscribe();
        try {
          if (handle) await handle.stop();
        } catch {
          // ignore
        }
        controller.close();
      }
    },
    cancel: () => {
      // Client disconnected. The narrator's progress loop will eventually
      // throw on next event emit and the start() finally block handles cleanup.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering on Vercel/Next.
      'X-Accel-Buffering': 'no',
    },
  });
}

// POST /api/tutor/start
// Body: { input_text: string }
// Response: text/event-stream (SSE) with ProgressEvent payloads.
//
// First event: { type: 'session_started', session_id, channel, agent_id, rtc_token, rtm_token, client_uid }
// Subsequent events: snapshot, segment_started, segment_completed, narration_complete, error
//
// The client opens this with `fetch(...).body` and parses SSE chunks. Once
// session_started arrives, it joins the RTC channel with the provided token
// and listens for transcript / agent_state events the usual way.

import { NextRequest } from 'next/server';
import { startTutorSession } from '@/lib/orchestrator';
import type { ProgressEvent } from '@/lib/orchestrator';

export const runtime = 'nodejs';
// SSE streams need to stay open longer than the default route timeout.
export const maxDuration = 600;

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
    return new Response(
      JSON.stringify({ error: 'input_text exceeds 8000 chars (Phase 1 limit)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const agora_app_id = requireEnv('NEXT_PUBLIC_AGORA_APP_ID');
  const agora_app_certificate = requireEnv('NEXT_AGORA_APP_CERTIFICATE');
  const agent_uid = process.env.NEXT_PUBLIC_AGENT_UID ?? '1';

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // Controller closed (client disconnected). Swallow.
        }
      };

      let handle: Awaited<ReturnType<typeof startTutorSession>> | null = null;
      let unsubscribe: (() => void) | null = null;
      try {
        handle = await startTutorSession({
          input_text: text,
          config: { agora_app_id, agora_app_certificate, agent_uid },
        });

        // Subscribe to progress events FIRST so we don't miss any
        unsubscribe = handle.progress.subscribe((e) => send(e));

        // Now kick off narration. The orchestrator will emit session_started
        // as its first event after this call.
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
      // Client disconnected — narration loop will throw on next emit and
      // be caught by the start() try/finally above.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering on Vercel/Next
      'X-Accel-Buffering': 'no',
    },
  });
}

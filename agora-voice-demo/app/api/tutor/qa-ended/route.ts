// app/api/tutor/qa-ended/route.ts
//
// POST /api/tutor/qa-ended
// Body: { session_id, qa_history }
// Effect: triggers bridge + rescript on the active session.

import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/orchestrator/session-registry';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { session_id?: string; qa_history?: Array<{ role: 'user' | 'agent'; text: string; ts: number }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const handle = get(body.session_id);
  if (!handle) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Kick off handleQaEnded in the background; respond 202 immediately so the
  // browser isn't held open for the bridge+rescript wallclock. Progress flows
  // through the existing SSE stream from /api/tutor/start.
  handle.handleQaEnded({ qa_history: body.qa_history ?? [] }).catch((err) => {
    console.warn('[qa-ended] handler threw:', err);
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

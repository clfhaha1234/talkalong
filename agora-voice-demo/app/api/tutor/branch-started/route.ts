// app/api/tutor/branch-started/route.ts
//
// POST /api/tutor/branch-started
// Body: { session_id }
// Effect: the INSTANT the browser detects barge-in (agent speaking→listening),
// pause the narrator + cut the agent's in-flight TTS — so the story stops the
// moment the listener speaks, instead of talking over them until the silence-
// confirm + qa-ended fires ~2s later. Resume planning still happens in
// /api/tutor/qa-ended once the listener goes quiet.

import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/orchestrator/session-registry';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: { session_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.session_id) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  const handle = get(body.session_id);
  if (!handle) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  try {
    handle.beginBranch();
  } catch (err) {
    console.warn('[branch-started] beginBranch threw:', err);
  }
  return NextResponse.json({ accepted: true }, { status: 202 });
}

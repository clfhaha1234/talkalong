// app/api/tutor/stop/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/orchestrator/session-registry';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: { session_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body.session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const handle = get(body.session_id);
  if (!handle) return NextResponse.json({ stopped: false, reason: 'not_found' }, { status: 404 });
  await handle.stop();
  return NextResponse.json({ stopped: true });
}

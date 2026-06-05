// After a QA interruption, decide whether the child's request should change the
// REST of the story (language/tone/pace/focus) and, if so, rewrite + re-voice
// the not-yet-played scenes. Mirrors /tutor's rescript, but for /stepfun's
// pre-generated scenes: the client swaps in the new narration text + audio.
//
// body: { question, answer, scenes: [{id, narration}] }   (remaining scenes)
// → { changed, scenes: [{id, narration, audioDataUrl}] }   (only when changed)
import { NextRequest, NextResponse } from 'next/server';
import { stepTTS } from '@/lib/stepfun/client';
import { rescriptRemaining } from '@/lib/stepfun/rescript';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { question, answer, scenes } = (await req.json()) as {
      question?: string;
      answer?: string;
      scenes?: Array<{ id: string; narration: string }>;
    };
    if (!question || !Array.isArray(scenes) || scenes.length === 0) {
      return NextResponse.json({ changed: false, scenes: [] });
    }

    const outcome = await rescriptRemaining({
      question,
      answer: answer ?? '',
      scenes: scenes.map((s) => ({ id: s.id, narration: s.narration })),
    });
    if (!outcome.changed) return NextResponse.json({ changed: false, scenes: [] });

    // Re-voice each rewritten scene (parallel — these are upcoming, not on the
    // hot barge-in path).
    const voiced = await Promise.all(
      outcome.scenes.map(async (s) => {
        const mp3 = await stepTTS(s.narration, { voice: 'lively-girl' }).catch(() => Buffer.alloc(0));
        return {
          id: s.id,
          narration: s.narration,
          audioDataUrl: mp3.length ? `data:audio/mp3;base64,${mp3.toString('base64')}` : '',
        };
      }),
    );
    return NextResponse.json({ changed: true, scenes: voiced });
  } catch (e) {
    return NextResponse.json(
      { changed: false, scenes: [], error: e instanceof Error ? e.message : 'rescript failed' },
      { status: 200 },
    );
  }
}

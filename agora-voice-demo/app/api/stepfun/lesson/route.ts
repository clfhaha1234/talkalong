// StepFun storybook generator. POST { topic } → a 3-scene illustrated, narrated
// lesson, generated entirely on StepFun (LLM + image + TTS). Server-side only —
// the StepFun key never reaches the browser.
//
// This is the NON-realtime core (story + images + narration + typed QA). The
// realtime barge-in voice loop is layered on separately.
import { NextRequest, NextResponse } from 'next/server';
import { stepChat, stepImage, stepTTS } from '@/lib/stepfun/client';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface SceneDraft {
  narration: string;
  image_prompt: string;
}

function safeParseScenes(raw: string): SceneDraft[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const arr = JSON.parse(s) as SceneDraft[];
  return arr
    .filter((x) => x && typeof x.narration === 'string' && typeof x.image_prompt === 'string')
    .slice(0, 5);
}

export async function POST(req: NextRequest) {
  try {
    const { topic } = (await req.json()) as { topic?: string };
    if (!topic || !topic.trim()) {
      return NextResponse.json({ error: 'topic is required' }, { status: 400 });
    }

    // 1) LLM: draft scenes as structured JSON.
    const raw = await stepChat(
      [
        {
          role: 'system',
          content:
            'You are a bedtime-storybook author for ages 8-12. Output ONLY a JSON array of exactly 3 scenes, no prose, no markdown fences. Each scene: {"narration": "2-3 warm sentences of story prose", "image_prompt": "a vivid visual description for an illustrator, no text in image"}. Keep narration under 280 characters.',
        },
        { role: 'user', content: `Topic: ${topic.trim()}` },
      ],
      { reasoningEffort: 'low', maxTokens: 3000 },
    );
    const drafts = safeParseScenes(raw);
    if (drafts.length === 0) {
      return NextResponse.json({ error: 'story generation returned no scenes', raw: raw.slice(0, 300) }, { status: 502 });
    }

    // 2) Per scene: image + narration audio, in parallel across scenes.
    const scenes = await Promise.all(
      drafts.map(async (d, i) => {
        const [imageUrl, mp3] = await Promise.all([
          stepImage(
            `Cozy watercolor storybook illustration, warm soft colors, no text: ${d.image_prompt}`,
            { size: '1360x768', responseFormat: 'url' },
          ).catch(() => ''),
          stepTTS(d.narration, { voice: 'lively-girl' }).catch(() => Buffer.alloc(0)),
        ]);
        return {
          id: `s${i + 1}`,
          narration: d.narration,
          imageUrl,
          audioDataUrl: mp3.length ? `data:audio/mp3;base64,${mp3.toString('base64')}` : '',
        };
      }),
    );

    // The full story so far, for the QA route to ground answers.
    const storySoFar = drafts.map((d) => d.narration).join(' ');
    return NextResponse.json({ topic: topic.trim(), scenes, storySoFar });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'lesson generation failed' },
      { status: 500 },
    );
  }
}

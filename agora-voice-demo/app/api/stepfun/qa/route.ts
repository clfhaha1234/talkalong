// StepFun Q&A: POST { question, storySoFar } → a one-sentence in-character
// answer (LLM) + its narration audio (TTS). The typed-question path of the
// StepFun tutor. Server-side only.
import { NextRequest, NextResponse } from 'next/server';
import { stepChat, stepTTS } from '@/lib/stepfun/client';
import { STEPFUN_QA_SYSTEM, stepfunQaUserMessage } from '@/lib/stepfun/persona';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { question, storySoFar } = (await req.json()) as {
      question?: string;
      storySoFar?: string;
    };
    if (!question || !question.trim()) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }

    const answer = await stepChat(
      [
        { role: 'system', content: STEPFUN_QA_SYSTEM },
        { role: 'user', content: stepfunQaUserMessage(question, storySoFar ?? '') },
      ],
      { reasoningEffort: 'low', maxTokens: 2048 },
    );

    const mp3 = await stepTTS(answer || 'Let me think about that one.', { voice: 'lively-girl' }).catch(
      () => Buffer.alloc(0),
    );

    return NextResponse.json({
      answer,
      audioDataUrl: mp3.length ? `data:audio/mp3;base64,${mp3.toString('base64')}` : '',
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'qa failed' },
      { status: 500 },
    );
  }
}

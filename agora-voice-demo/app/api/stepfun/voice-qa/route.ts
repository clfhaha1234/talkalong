// StepFun spoken Q&A: the realtime barge-in turn. The browser records the
// listener's spoken question (after client-side VAD detects speech), POSTs the
// audio here, and we run ASR → LLM → TTS and return the transcript + answer +
// answer audio. Server-side only (key never leaves the server).
//
// multipart body: file=<audio blob>, storySoFar=<string>
import { NextRequest, NextResponse } from 'next/server';
import { stepASR, stepChat, stepTTS } from '@/lib/stepfun/client';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const storySoFar = String(form.get('storySoFar') ?? '');
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: 'audio file is required' }, { status: 400 });
    }

    // 1) ASR — transcribe the spoken question.
    const filename = (file as File).name || 'q.webm';
    const question = await stepASR(file, filename);
    if (!question || question.trim().length < 2) {
      // Likely a false barge-in (a cough, "uh") — tell the client to just resume.
      return NextResponse.json({ question, answer: '', audioDataUrl: '', backChannel: true });
    }

    // 2) LLM — answer in character, grounded on the story so far.
    const answer = await stepChat(
      [
        {
          role: 'system',
          content:
            "You are the warm storyteller. Answer the child's question in ONE short sentence, in character. If it is a fact already in the story so far, answer it directly. If the story hasn't introduced it yet, never invent it — say warmly that it's coming up. Do not narrate further, do not bridge back.",
        },
        {
          role: 'user',
          content: `Story so far: "${storySoFar.slice(0, 2000)}"\n\nThe child asked: ${question.trim()}`,
        },
      ],
      { reasoningEffort: 'low', maxTokens: 1024 },
    );

    // 3) TTS — speak the answer.
    const mp3 = await stepTTS(answer || 'Let me think about that, little one.', { voice: 'lively-girl' }).catch(
      () => Buffer.alloc(0),
    );

    return NextResponse.json({
      question: question.trim(),
      answer,
      audioDataUrl: mp3.length ? `data:audio/mp3;base64,${mp3.toString('base64')}` : '',
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'voice-qa failed' },
      { status: 500 },
    );
  }
}

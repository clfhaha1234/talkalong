// StepFun spoken Q&A: the realtime barge-in turn. The browser records the
// listener's spoken question (after client-side VAD detects speech), POSTs the
// audio here, and we run ASR → LLM → TTS and return the transcript + answer +
// answer audio. Server-side only (key never leaves the server).
//
// multipart body: file=<audio blob>, storySoFar=<string>
import { NextRequest, NextResponse } from 'next/server';
import { stepASR, stepChat, stepTTS } from '@/lib/stepfun/client';
import { STEPFUN_QA_SYSTEM, stepfunQaUserMessage, looksLikeNarrationEcho } from '@/lib/stepfun/persona';
import { completeQa } from '@/lib/stepfun/qaBrain';

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
    // Echo guard: the mic only caught the narration playing back, not a question.
    if (looksLikeNarrationEcho(question, storySoFar)) {
      return NextResponse.json({ question, answer: '', audioDataUrl: '', backChannel: true, echo: true });
    }

    // 2) LLM — answer in character, grounded on the story so far.
    const messages = [
      { role: 'system' as const, content: STEPFUN_QA_SYSTEM },
      { role: 'user' as const, content: stepfunQaUserMessage(question, storySoFar) },
    ];
    const answer = (await completeQa(messages)) ?? await stepChat(
      messages,
      // Fallback only: step-3.7-flash is a reasoning model and can be slow.
      { reasoningEffort: 'low', maxTokens: 2048, temperature: 0 },
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

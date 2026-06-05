// Streaming spoken-QA turn. Same job as /voice-qa but the answer audio is
// STREAMED so playback can start ~1.5s sooner:
//   ASR (parallel with WS handshake) → LLM stream → pipe deltas into the
//   StepFun realtime TTS WebSocket → relay audio chunks to the client as SSE.
//
// SSE events (each `data: <json>\n\n`):
//   {t:'meta', question}             — the transcript, as soon as ASR returns
//   {t:'backChannel', echo?}         — false barge-in / narration echo → just resume
//   {t:'answer', answer}             — the full answer text (after the LLM finishes)
//   {t:'audio', audio, status}       — a base64 mp3 chunk ('unfinished'|'finished')
//   {t:'error', message}
//   {t:'done'}                       — stream complete
import { NextRequest } from 'next/server';
import { stepASR, stepChatStream } from '@/lib/stepfun/client';
import { openTtsStream, type TtsStream } from '@/lib/stepfun/wsTts';
import { STEPFUN_QA_SYSTEM, stepfunQaUserMessage, looksLikeNarrationEcho } from '@/lib/stepfun/persona';
import { shouldUseGeminiQaBrain, streamQa } from '@/lib/stepfun/qaBrain';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file');
  const storySoFar = String(form.get('storySoFar') ?? '');

  const encoder = new TextEncoder();

  // State hoisted so both start() and cancel() (client disconnect) can tear down
  // the guard timer and the upstream TTS WebSocket — otherwise late timer/WS
  // callbacks enqueue onto a runtime-closed controller and throw uncaught.
  let closed = false;
  let guard: ReturnType<typeof setTimeout> | null = null;
  let tts: TtsStream | null = null;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (guard) { clearTimeout(guard); guard = null; }
    try { tts?.close(); } catch { /* */ }
    tts = null;
  };
  const send = (obj: unknown) => {
    if (closed || !ctrl) return;
    try { ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); }
    catch { closed = true; cleanup(); } // controller already closed downstream
  };
  const end = () => {
    if (closed) { cleanup(); return; }
    send({ t: 'done' });
    closed = true;
    cleanup();
    try { ctrl?.close(); } catch { /* already closed */ }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      ctrl = controller;
      guard = setTimeout(() => { send({ t: 'error', message: 'timeout' }); end(); }, 45000);

      try {
        if (!(file instanceof Blob) || file.size === 0) {
          send({ t: 'error', message: 'audio file is required' }); end(); return;
        }

        // 1) ASR — transcribe the spoken question.
        const filename = (file as File).name || 'q.webm';
        const question = (await stepASR(file, filename)).trim();
        if (closed) return;
        if (question.length < 2) {
          send({ t: 'backChannel' }); end(); return; // cough / no words → resume
        }
        if (looksLikeNarrationEcho(question, storySoFar)) {
          send({ t: 'backChannel', echo: true }); end(); return; // mic caught the narration
        }
        send({ t: 'meta', question });

        // 2) Open the TTS WS now; its ~0.65s handshake overlaps the LLM call.
        tts = openTtsStream({
          voiceId: 'lively-girl',
          format: 'mp3',
          onAudio: (audio, status) => send({ t: 'audio', audio, status }),
          onDone: () => end(),
          onError: (message) => { send({ t: 'error', message }); end(); },
        });

        // 3) LLM stream → pipe each delta straight into TTS.
        let answer = '';
        const messages = [
          { role: 'system' as const, content: STEPFUN_QA_SYSTEM },
          { role: 'user' as const, content: stepfunQaUserMessage(question, storySoFar) },
        ];
        try {
          const llmStream = shouldUseGeminiQaBrain()
            ? streamQa(messages)
            : stepChatStream(
                messages,
                // Fallback only: step-3.7-flash is a reasoning model and can be slow.
                { reasoningEffort: 'low', maxTokens: 2048, temperature: 0 },
              );
          for await (const delta of llmStream) {
            if (closed) return; // client disconnected mid-answer
            answer += delta;
            tts.pushText(delta);
          }
        } catch (e) {
          send({ t: 'error', message: e instanceof Error ? e.message : 'llm stream failed' });
        }
        if (closed) return;
        // Defensive: never leave TTS with nothing to say (empty answer → no audio).
        if (!answer.trim()) { answer = 'Let me think about that one, little one.'; tts.pushText(answer); }
        send({ t: 'answer', answer });
        tts.finish(); // flush remaining text; audio onDone() will end the stream
      } catch (e) {
        send({ t: 'error', message: e instanceof Error ? e.message : 'voice-qa-stream failed' });
        end();
      }
    },
    cancel() { closed = true; cleanup(); }, // client disconnected — stop the WS
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

// Server-side wrapper around StepFun's realtime streaming-TTS WebSocket.
// (https://api.stepfun.ai/v1/realtime/audio — header-auth, NOT the .com host.)
//
// Proven flow (scripts/stepfun/ws-tts-probe.ts):
//   connect → `tts.connection.done` {session_id}  ← echo this id back, not your own
//          → send `tts.create`        → `tts.response.created`
//          → `tts.text.delta`*        (incremental text — pipe LLM deltas straight in)
//          → `tts.text.flush` + `tts.text.done`
//   server → `tts.response.audio.delta` {audio:b64, status} … status:'finished'
//          → `tts.response.audio.done`
//
// First audio lands ~0.7s after the first text delta; the ~0.65s handshake can
// overlap upstream ASR+LLM. This is what turns the un-streamable HTTP TTS wall
// (whole mp3 only after ~3.5s) into progressive playback.
import WebSocket from 'ws';

const WS_URL = process.env.STEPFUN_TTS_WS_URL ?? 'wss://api.stepfun.ai/v1/realtime/audio?model=step-tts-2';

export interface TtsStreamOptions {
  voiceId?: string;
  /** mp3 is the safest for MediaSource playback in the browser. */
  format?: 'mp3' | 'wav' | 'pcm';
  sampleRate?: number;
  onAudio: (b64: string, status: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

export interface TtsStream {
  /** Append text to synthesize. Buffered until the session is created. */
  pushText(text: string): void;
  /** No more text — flush remaining + close the input side. */
  finish(): void;
  /** Tear down the socket. */
  close(): void;
}

export function openTtsStream(opts: TtsStreamOptions): TtsStream {
  const key = process.env.STEPFUN_API_KEY;
  if (!key) {
    opts.onError('STEPFUN_API_KEY is not set');
    return { pushText() {}, finish() {}, close() {} };
  }

  const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${key}` } });
  let sessionId = '';
  let created = false;
  let finished = false;
  let closed = false;
  const pending: string[] = []; // text buffered before `created`
  let pendingFinish = false;

  const send = (type: string, data: Record<string, unknown> = {}) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data: { session_id: sessionId, ...data } }));
  };

  const flushPending = () => {
    for (const t of pending) send('tts.text.delta', { text: t });
    pending.length = 0;
    if (pendingFinish) { send('tts.text.flush'); send('tts.text.done'); }
  };

  ws.on('message', (raw) => {
    let ev: { type?: string; data?: { session_id?: string; audio?: string; status?: string; message?: string } };
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    switch (ev.type) {
      case 'tts.connection.done':
        sessionId = ev.data?.session_id ?? '';
        send('tts.create', {
          voice_id: opts.voiceId ?? 'lively-girl',
          response_format: opts.format ?? 'mp3',
          sample_rate: opts.sampleRate ?? 24000,
        });
        break;
      case 'tts.response.created':
        created = true;
        flushPending();
        break;
      case 'tts.response.audio.delta': {
        const b64 = ev.data?.audio ?? '';
        const status = ev.data?.status ?? 'unfinished';
        if (b64) opts.onAudio(b64, status);
        if (status === 'finished') finalize();
        break;
      }
      case 'tts.response.audio.done':
        finalize();
        break;
      case 'tts.response.error':
      case 'error':
      case 'tts.error':
        opts.onError(ev.data?.message ?? ev.type ?? 'tts ws error');
        close();
        break;
    }
  });

  ws.on('error', (e) => { opts.onError(e.message); });
  ws.on('close', () => { if (!finished) { /* upstream closed early */ } });

  function finalize() {
    if (finished) return;
    finished = true;
    opts.onDone();
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* noop */ }
  }

  return {
    pushText(text: string) {
      if (!text || finished) return;
      if (created) send('tts.text.delta', { text });
      else pending.push(text);
    },
    finish() {
      if (created) { send('tts.text.flush'); send('tts.text.done'); }
      else pendingFinish = true;
    },
    close,
  };
}

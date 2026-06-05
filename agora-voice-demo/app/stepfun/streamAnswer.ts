'use client';

// Client half of the streaming spoken-QA turn. POSTs the recorded question to
// /api/stepfun/voice-qa-stream and plays the answer audio AS IT ARRIVES (via
// MediaSource) so the child hears the first words ~1.5s sooner than waiting for
// the whole mp3. Falls back to buffer-then-play where MSE can't do audio/mpeg.
//
// The caller passes the <audio> element it already owns (so it can pause it for
// a barge-in mid-answer, exactly like the non-streaming path did).

export interface StreamAnswerCallbacks {
  onQuestion?: (q: string) => void;
  onAnswer?: (a: string) => void;
  /** false barge-in / narration echo — nothing to play, just resume narration. */
  onBackChannel?: (echo: boolean) => void;
  /** first audio is buffered and playback is starting. */
  onPlaybackStart?: () => void;
  /** This answer should leave the tutor waiting for a follow-up, not resume. */
  onHold?: () => void;
  /** the answer audio finished playing on its own (not interrupted). */
  onEnded?: () => void;
  onError?: (msg: string) => void;
}

export interface StreamAnswerResult {
  question: string;
  answer: string;
  backChannel: boolean;
  hold: boolean;
  played: boolean;
}

const MP3_MIME = 'audio/mpeg';
const canMSE = () =>
  typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(MP3_MIME);

export async function streamAnswer(
  blob: Blob,
  storySoFar: string,
  audioEl: HTMLAudioElement,
  cb: StreamAnswerCallbacks = {},
  signal?: AbortSignal,
): Promise<StreamAnswerResult> {
  const fd = new FormData();
  fd.append('file', blob, 'q.webm');
  fd.append('storySoFar', storySoFar);

  const res = await fetch('/api/stepfun/voice-qa-stream', { method: 'POST', body: fd, signal });
  if (!res.ok || !res.body) throw new Error(`voice-qa-stream HTTP ${res.status}`);

  // MediaSource progressive-playback plumbing (mp3 fast path).
  const useMSE = canMSE();
  const fallbackChunks: Uint8Array[] = [];
  let question = '';
  let answer = '';
  let backChannel = false;
  let hold = false;
  let played = false;
  let startedPlayback = false;

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  const appendQueue: Uint8Array[] = [];
  let inputEnded = false;

  const pump = () => {
    if (!sourceBuffer || sourceBuffer.updating || appendQueue.length === 0) return;
    const next = appendQueue.shift()!;
    try { sourceBuffer.appendBuffer(next.buffer as ArrayBuffer); } catch { /* buffer full / closed */ }
  };
  const maybeEndStream = () => {
    if (inputEnded && mediaSource && mediaSource.readyState === 'open' && sourceBuffer && !sourceBuffer.updating && appendQueue.length === 0) {
      try { mediaSource.endOfStream(); } catch { /* */ }
    }
  };

  if (useMSE) {
    mediaSource = new MediaSource();
    audioEl.src = URL.createObjectURL(mediaSource);
    await new Promise<void>((resolve) => {
      mediaSource!.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource!.addSourceBuffer(MP3_MIME);
          sourceBuffer.addEventListener('updateend', () => { pump(); maybeEndStream(); });
        } catch { /* fall through; fallback path will catch */ }
        resolve();
      }, { once: true });
    });
    // Resume narration when the answer finishes on its own. A barge-in mid-answer
    // pauses the element instead (no 'ended'), so this only fires on clean finish.
    audioEl.onended = () => cb.onEnded?.();
  }

  const feedChunk = (bytes: Uint8Array) => {
    if (useMSE && sourceBuffer) {
      appendQueue.push(bytes);
      pump();
      if (!startedPlayback) {
        startedPlayback = true;
        played = true;
        cb.onPlaybackStart?.();
        void audioEl.play().catch(() => {});
      }
    } else {
      fallbackChunks.push(bytes);
    }
  };

  // Read the SSE stream.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev: { t?: string; question?: string; answer?: string; hold?: boolean; echo?: boolean; audio?: string; status?: string; message?: string };
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        switch (ev.t) {
          case 'meta': question = ev.question ?? ''; cb.onQuestion?.(question); break;
          case 'backChannel': backChannel = true; cb.onBackChannel?.(!!ev.echo); break;
          case 'answer':
            answer = ev.answer ?? '';
            hold = !!ev.hold;
            if (hold) cb.onHold?.();
            cb.onAnswer?.(answer);
            break;
          case 'audio': if (ev.audio) feedChunk(base64ToBytes(ev.audio)); break;
          case 'error': cb.onError?.(ev.message ?? 'stream error'); break;
          case 'done': break;
        }
      }
    }
  } finally {
    inputEnded = true;
  }

  if (backChannel) return { question, answer, backChannel, hold: false, played: false };

  if (useMSE) {
    maybeEndStream(); // signal end-of-input so the <audio> will fire 'ended'
  } else if (fallbackChunks.length) {
    // Fallback: assemble the whole mp3 and play it in one go.
    const whole = new Blob(fallbackChunks as BlobPart[], { type: MP3_MIME });
    audioEl.src = URL.createObjectURL(whole);
    audioEl.onended = () => cb.onEnded?.();
    played = true;
    cb.onPlaybackStart?.();
    void audioEl.play().catch(() => cb.onEnded?.());
  }

  // Resolve as soon as the answer is received + playback has started; the caller
  // resumes narration from cb.onEnded (or immediately if nothing played).
  return { question, answer, backChannel, hold, played };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

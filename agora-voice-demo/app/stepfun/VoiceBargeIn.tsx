'use client';

// Realtime barge-in voice loop for the StepFun storybook — the part Agora
// ConvoAI gave us for free, rebuilt from StepFun primitives + browser audio.
//
// How it works (no WebSocket relay needed):
//   - Narration plays scene-by-scene (pre-generated StepFun TTS mp3).
//   - A client-side VAD (Web Audio RMS) listens on the mic continuously.
//   - The INSTANT the listener starts speaking, we PAUSE narration (barge-in) —
//     this is local + sub-frame, no round-trip.
//   - We record the utterance until the VAD hears ~0.9s of silence, then POST
//     the clip to /api/stepfun/voice-qa (ASR → LLM → TTS) and play the answer.
//   - After the answer finishes, we leave a short follow-up window before the
//     narration resumes where it left off.

import { useCallback, useEffect, useRef, useState } from 'react';
import { streamAnswer } from './streamAnswer';

export interface VoiceScene {
  id: string;
  narration: string;
  audioDataUrl: string;
}

type Phase = 'off' | 'narrating' | 'listening' | 'thinking' | 'answering' | 'paused';

// VAD tuning (RMS of float PCM in [0,1]). Mic-dependent; reasonable defaults.
const SPEECH_RMS = 0.035; // above this = voice
const SILENCE_RMS = 0.02; // below this = quiet
const SPEECH_MS = 180; // sustained voice to count as a real barge-in
const SILENCE_MS = 900; // sustained quiet = end of the question
const MIN_UTTERANCE_MS = 400; // ignore blips shorter than this
const FOLLOW_UP_WINDOW_MS = 4000; // mirrors /tutor's after-answer grace

export default function VoiceBargeIn({
  scenes,
  enabled,
  hideControls = false,
  onPhaseChange,
  onSceneChange,
  onQuestion,
  onAnswer,
  onMicError,
}: {
  scenes: VoiceScene[];
  enabled?: boolean;
  hideControls?: boolean;
  onPhaseChange?: (phase: Phase, status: string) => void;
  onSceneChange?: (index: number) => void;
  onQuestion?: (question: string) => void;
  onAnswer?: (answer: string) => void;
  onMicError?: (message: string | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>('off');
  const [sceneIdx, setSceneIdx] = useState(0);
  const [status, setStatus] = useState('');
  const [transcript, setTranscript] = useState<{ q: string; a: string }[]>([]);
  const [micError, setMicError] = useState<string | null>(null);

  const narrationRef = useRef<HTMLAudioElement | null>(null);
  const answerRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('off');
  const sceneIdxRef = useRef(0);
  const scenesRef = useRef<VoiceScene[]>(scenes);
  const sceneAudioRef = useRef<Map<string, string>>(new Map());
  // VAD timers
  const speechStartRef = useRef<number>(0);
  const silenceStartRef = useRef<number>(0);
  const recStartRef = useRef<number>(0);
  const interruptedNarrationRef = useRef<{ idx: number; currentTime: number } | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { sceneIdxRef.current = sceneIdx; }, [sceneIdx]);
  useEffect(() => {
    const previousAudio = sceneAudioRef.current;
    const nextAudio = new Map(scenes.map((s) => [s.id, s.audioDataUrl]));
    scenesRef.current = scenes;
    sceneAudioRef.current = nextAudio;

    const current = scenes[sceneIdxRef.current];
    if (!current || phaseRef.current !== 'narrating') return;
    const prevSrc = previousAudio.get(current.id);
    if (!prevSrc || prevSrc === current.audioDataUrl || !current.audioDataUrl) return;

    const audio = narrationRef.current;
    if (!audio) return;
    audio.pause();
    audio.src = current.audioDataUrl;
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  }, [scenes]);
  useEffect(() => { onPhaseChange?.(phase, status); }, [onPhaseChange, phase, status]);
  useEffect(() => { onSceneChange?.(sceneIdx); }, [onSceneChange, sceneIdx]);
  useEffect(() => { onMicError?.(micError); }, [onMicError, micError]);

  const playNarration = useCallback((idx: number, resumeAt?: number) => {
    const currentScenes = scenesRef.current;
    const sc = currentScenes[idx];
    if (!sc) { setPhase('paused'); setStatus('— the end —'); return; }
    setSceneIdx(idx);
    if (!narrationRef.current) narrationRef.current = new Audio();
    const a = narrationRef.current;
    a.src = sc.audioDataUrl;
    if (resumeAt != null && Number.isFinite(resumeAt)) {
      a.currentTime = Math.max(0, resumeAt);
    }
    a.onended = () => {
      // advance to the next scene when this one finishes (unless we're mid-QA)
      if (phaseRef.current === 'narrating') playNarration(idx + 1);
    };
    setPhase('narrating');
    setStatus(`narrating scene ${idx + 1}/${currentScenes.length}`);
    void a.play().catch(() => {});
  }, []);

  const resumeNarration = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    const interrupted = interruptedNarrationRef.current;
    interruptedNarrationRef.current = null;
    if (interrupted) {
      playNarration(interrupted.idx, interrupted.currentTime);
    } else {
      playNarration(sceneIdxRef.current);
    }
  }, [playNarration]);

  const scheduleFollowUpResume = useCallback((delayMs = FOLLOW_UP_WINDOW_MS) => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    speechStartRef.current = 0;
    silenceStartRef.current = 0;
    setPhase('listening');
    setStatus('listening…');
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      if (phaseRef.current !== 'listening' || recRef.current) return;
      resumeNarration();
    }, delayMs);
  }, [resumeNarration]);

  // The spoken-QA turn: stream the answer audio (plays the first words ~1.5s
  // sooner than waiting for the whole mp3), then leave a brief follow-up window
  // before resuming narration.
  const handleUtterance = useCallback(async (blob: Blob) => {
    setPhase('thinking');
    setStatus('thinking…');
    const storySoFar = scenes
      .slice(0, sceneIdxRef.current + 1)
      .map((s) => s.narration)
      .join(' ');
    if (!answerRef.current) answerRef.current = new Audio();
    try {
      const r = await streamAnswer(blob, storySoFar, answerRef.current, {
        onQuestion: (q) => {
          const question = q || '(…)';
          onQuestion?.(question);
          setTranscript((t) => [...t, { q: question, a: '' }]);
        },
        onAnswer: (a) => setTranscript((t) => {
          onAnswer?.(a);
          // fill the answer into the last (matching) question row
          const next = [...t];
          for (let i = next.length - 1; i >= 0; i--) { if (!next[i].a) { next[i] = { ...next[i], a }; break; } }
          return next;
        }),
        onBackChannel: () => { setStatus('…go on'); resumeNarration(); },
        onPlaybackStart: () => { setPhase('answering'); setStatus('answering…'); },
        onEnded: () => scheduleFollowUpResume(),
      });
      // Nothing played (back-channel handled above, or empty) → make sure we resume.
      if (!r.backChannel && !r.played) scheduleFollowUpResume();
    } catch (e) {
      setStatus(`(qa error: ${e instanceof Error ? e.message : 'failed'})`);
      resumeNarration();
    }
  }, [scenes, resumeNarration, scheduleFollowUpResume]);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    chunksRef.current = [];
    const mimeType = pickMime();
    const rec = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType });
      const dur = Date.now() - recStartRef.current;
      if (dur >= MIN_UTTERANCE_MS && blob.size > 800) void handleUtterance(blob);
      else { setStatus('…go on'); resumeNarration(); } // too short → ignore
    };
    recStartRef.current = Date.now();
    rec.start();
    recRef.current = rec;
  }, [handleUtterance, resumeNarration]);

  const stopRecording = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    recRef.current = null;
  }, []);

  // The VAD loop — runs while the mic is live.
  const tick = useCallback(() => {
    const an = analyserRef.current;
    if (!an) return;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    const ph = phaseRef.current;

    const waitingForSpeech = ph === 'narrating' || ph === 'paused' || ph === 'answering' || (ph === 'listening' && !recRef.current);
    if (waitingForSpeech) {
      // Listen for a barge-in.
      if (rms > SPEECH_RMS) {
        if (!speechStartRef.current) speechStartRef.current = now;
        if (now - speechStartRef.current >= SPEECH_MS) {
          // BARGE-IN — pause narration/answer INSTANTLY and start recording.
          if (narrationRef.current && !narrationRef.current.paused) {
            interruptedNarrationRef.current = {
              idx: sceneIdxRef.current,
              currentTime: narrationRef.current.currentTime,
            };
            narrationRef.current.pause();
          }
          answerRef.current?.pause();
          speechStartRef.current = 0;
          silenceStartRef.current = 0;
          setPhase('listening');
          setStatus('listening…');
          startRecording();
        }
      } else {
        speechStartRef.current = 0;
      }
    } else if (ph === 'listening') {
      // Wait for the listener to finish (sustained silence).
      if (rms < SILENCE_RMS) {
        if (!silenceStartRef.current) silenceStartRef.current = now;
        if (now - silenceStartRef.current >= SILENCE_MS) {
          silenceStartRef.current = 0;
          stopRecording();
        }
      } else {
        silenceStartRef.current = 0;
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [startRecording, stopRecording]);

  const start = useCallback(async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      acRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      analyserRef.current = an;
      rafRef.current = requestAnimationFrame(tick);
      playNarration(0);
    } catch (e) {
      setMicError(e instanceof Error ? e.message : 'mic access denied');
      setPhase('off');
    }
  }, [tick, playNarration]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    narrationRef.current?.pause();
    answerRef.current?.pause();
    stopRecording();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    acRef.current?.close().catch(() => {});
    streamRef.current = null;
    setPhase('off');
    setStatus('');
  }, [stopRecording]);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    if (enabled === undefined) return;
    if (enabled && phaseRef.current === 'off') {
      void start();
    } else if (!enabled && phaseRef.current !== 'off') {
      stop();
    }
  }, [enabled, start, stop]);

  if (hideControls) return null;

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid #ece4d9', paddingTop: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {phase === 'off' ? (
          <button onClick={start} style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#7a4a3a', color: '#fff', cursor: 'pointer' }}>
            🎤 Read it to me (barge in anytime)
          </button>
        ) : (
          <button onClick={stop} style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #d8cfc4', background: '#fff', cursor: 'pointer' }}>
            ⏹ Stop
          </button>
        )}
        <span style={{ fontSize: 13, color: phase === 'listening' ? '#b00020' : '#8a7d72' }}>
          {phase === 'listening' ? '● ' : ''}{status || (phase === 'off' ? 'voice mode off' : phase)}
        </span>
      </div>
      {micError && <p style={{ color: '#b00020', fontSize: 13 }}>⚠ {micError}</p>}
      {transcript.map((t, i) => (
        <div key={i} style={{ marginTop: 10, fontSize: 14 }}>
          <div style={{ color: '#8a7d72' }}>🗣 {t.q}</div>
          <div>📖 {t.a}</div>
        </div>
      ))}
    </div>
  );
}

function pickMime(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const c of cands) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

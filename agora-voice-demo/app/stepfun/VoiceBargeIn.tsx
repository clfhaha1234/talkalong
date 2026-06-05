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
//   - Then narration resumes where it left off.

import { useCallback, useEffect, useRef, useState } from 'react';

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

export default function VoiceBargeIn({
  scenes,
  storySoFar,
}: {
  scenes: VoiceScene[];
  storySoFar: string;
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
  // VAD timers
  const speechStartRef = useRef<number>(0);
  const silenceStartRef = useRef<number>(0);
  const recStartRef = useRef<number>(0);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { sceneIdxRef.current = sceneIdx; }, [sceneIdx]);

  const playNarration = useCallback((idx: number) => {
    const sc = scenes[idx];
    if (!sc) { setPhase('paused'); setStatus('— the end —'); return; }
    setSceneIdx(idx);
    if (!narrationRef.current) narrationRef.current = new Audio();
    const a = narrationRef.current;
    a.src = sc.audioDataUrl;
    a.onended = () => {
      // advance to the next scene when this one finishes (unless we're mid-QA)
      if (phaseRef.current === 'narrating') playNarration(idx + 1);
    };
    setPhase('narrating');
    setStatus(`narrating scene ${idx + 1}/${scenes.length}`);
    void a.play().catch(() => {});
  }, [scenes]);

  // The spoken-QA turn: send the recorded clip, play the answer, then resume.
  const handleUtterance = useCallback(async (blob: Blob) => {
    setPhase('thinking');
    setStatus('thinking…');
    try {
      const fd = new FormData();
      fd.append('file', blob, 'q.webm');
      fd.append('storySoFar', storySoFar);
      const res = await fetch('/api/stepfun/voice-qa', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.backChannel || (!data.answer && !data.question)) {
        // false barge-in (cough / no words) — just resume.
        setStatus('…go on');
        playNarration(sceneIdxRef.current);
        return;
      }
      setTranscript((t) => [...t, { q: data.question || '(…)', a: data.answer || '' }]);
      if (data.audioDataUrl) {
        setPhase('answering');
        setStatus('answering…');
        if (!answerRef.current) answerRef.current = new Audio();
        const a = answerRef.current;
        a.src = data.audioDataUrl;
        a.onended = () => playNarration(sceneIdxRef.current); // resume same scene
        await a.play().catch(() => {});
      } else {
        playNarration(sceneIdxRef.current);
      }
    } catch (e) {
      setStatus(`(qa error: ${e instanceof Error ? e.message : 'failed'})`);
      playNarration(sceneIdxRef.current);
    }
  }, [storySoFar, playNarration]);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    const rec = new MediaRecorder(streamRef.current, { mimeType: pickMime() });
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType });
      const dur = Date.now() - recStartRef.current;
      if (dur >= MIN_UTTERANCE_MS && blob.size > 800) void handleUtterance(blob);
      else { setStatus('…go on'); playNarration(sceneIdxRef.current); } // too short → ignore
    };
    recStartRef.current = Date.now();
    rec.start();
    recRef.current = rec;
  }, [handleUtterance, playNarration]);

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

    if (ph === 'narrating' || ph === 'paused' || ph === 'answering') {
      // Listen for a barge-in.
      if (rms > SPEECH_RMS) {
        if (!speechStartRef.current) speechStartRef.current = now;
        if (now - speechStartRef.current >= SPEECH_MS) {
          // BARGE-IN — pause narration/answer INSTANTLY and start recording.
          narrationRef.current?.pause();
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

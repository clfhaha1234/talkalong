'use client';

// Realtime barge-in voice loop for the StepFun storybook — the part Agora
// ConvoAI gave us for free, rebuilt from StepFun primitives + browser audio.
//
// How it works (no WebSocket relay needed):
//   - Narration plays scene-by-scene (pre-generated StepFun TTS mp3).
//   - A client-side VAD (Web Audio RMS) listens on the mic continuously.
//   - The FIRST voiced frame ducks playback and starts a tentative recording —
//     instant perceived response, and the head of the question isn't clipped.
//     Sustained voice (SPEECH_MS) commits the barge-in: playback pauses and the
//     recording is kept; a shorter blip is discarded and the audio ramps back.
//   - Barge-in works in every phase, including 'thinking' (it aborts the
//     pending QA turn) and 'answering' (a false barge resumes the ANSWER).
//   - We record the utterance until the VAD hears ~0.9s of silence, then POST
//     the clip to /api/stepfun/voice-qa-stream (ASR → LLM → TTS) and play the
//     answer.
//   - After the answer finishes, we leave a short follow-up window before the
//     narration resumes slightly BEFORE where it left off (with a fade-in).

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
const THINKING_SPEECH_MS = 350; // higher bar mid-QA: a commit here cancels the pending answer
const SILENCE_MS = 900; // sustained quiet = end of the question
const MIN_UTTERANCE_MS = 400; // ignore blips shorter than this
const FOLLOW_UP_WINDOW_MS = 4000; // mirrors /tutor's after-answer grace
const QA_AUDIO_GUARD_RETRY_MS = 500;
const TENTATIVE_RECHECK_MS = 500; // follow-up timer re-poll while a blip is being evaluated
const DUCK_VOLUME = 0.12; // playback level the instant voice is heard, before commit
const FADE_IN_MS = 220;
const RESUME_REWIND_SEC = 1.0; // replay the last beat of narration after an interruption
const ANSWER_RESUME_REWIND_SEC = 0.5;

// Volume ramps so pause/duck/resume never click or hard-cut. Tokens let a newer
// ramp (or a duck) cancel an in-flight one on the same element.
const fadeTokens = new WeakMap<HTMLAudioElement, number>();
function cancelFade(a: HTMLAudioElement) {
  fadeTokens.set(a, (fadeTokens.get(a) ?? 0) + 1);
}
function fadeIn(a: HTMLAudioElement, ms = FADE_IN_MS) {
  const token = (fadeTokens.get(a) ?? 0) + 1;
  fadeTokens.set(a, token);
  const start = performance.now();
  a.volume = 0;
  const step = (now: number) => {
    if (fadeTokens.get(a) !== token) return;
    const k = Math.min(1, (now - start) / ms);
    a.volume = k;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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
  const interruptedAnswerRef = useRef<{ currentTime: number } | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tentative barge-in: recording starts on the FIRST voiced frame (so the head
  // of the question isn't clipped) but the recorder is discarded if the sound
  // turns out to be a blip shorter than SPEECH_MS.
  const tentativeRef = useRef(false);
  const recSessionRef = useRef<{ discard: boolean } | null>(null);
  // QA turn generation guard (tutor's branch-generation lesson): a newer spoken
  // turn aborts the in-flight one and stale callbacks must not touch state.
  const qaGenRef = useRef(0);
  const qaAbortRef = useRef<AbortController | null>(null);

  // Keep imperative audio callbacks/timers on the newest scene list even before
  // React effects run. This matters when rescripted narration lands at nearly
  // the same moment the after-answer resume timer fires.
  scenesRef.current = scenes;

  const isAnswerAudioPlaying = useCallback(() => {
    const a = answerRef.current;
    return !!a && !a.paused && !a.ended;
  }, []);

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
    cancelFade(audio);
    audio.volume = 1;
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
      fadeIn(a); // ease back in instead of hard-cutting mid-sentence
    } else {
      cancelFade(a);
      a.volume = 1;
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
    const doResume = () => {
      resumeTimerRef.current = null;
      const interrupted = interruptedNarrationRef.current;
      interruptedNarrationRef.current = null;
      if (interrupted) {
        // replay the last beat so the listener doesn't land mid-word
        playNarration(interrupted.idx, Math.max(0, interrupted.currentTime - RESUME_REWIND_SEC));
      } else {
        playNarration(sceneIdxRef.current);
      }
    };
    const waitForAnswerThenResume = () => {
      if (isAnswerAudioPlaying()) {
        resumeTimerRef.current = setTimeout(waitForAnswerThenResume, QA_AUDIO_GUARD_RETRY_MS);
        return;
      }
      doResume();
    };
    waitForAnswerThenResume();
  }, [isAnswerAudioPlaying, playNarration]);

  const scheduleFollowUpResume = useCallback((delayMs = FOLLOW_UP_WINDOW_MS) => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    speechStartRef.current = 0;
    silenceStartRef.current = 0;
    setPhase('listening');
    setStatus('listening…');
    const fire = () => {
      resumeTimerRef.current = null;
      if (phaseRef.current !== 'listening') return;
      if (recRef.current) {
        // a tentative blip is still being evaluated — don't lose the resume
        if (tentativeRef.current) resumeTimerRef.current = setTimeout(fire, TENTATIVE_RECHECK_MS);
        return;
      }
      resumeNarration();
    };
    resumeTimerRef.current = setTimeout(fire, delayMs);
  }, [resumeNarration]);

  // A barge-in that lands while the QA answer is playing pauses it; if that
  // barge turns out to be a false one (blip / back-channel / echo), resume the
  // ANSWER where it left off instead of skipping the rest of it.
  const resumeInterruptedAnswer = useCallback(() => {
    const saved = interruptedAnswerRef.current;
    interruptedAnswerRef.current = null;
    const a = answerRef.current;
    if (!saved || !a || !a.src) return false;
    const remaining = Number.isFinite(a.duration) ? a.duration - saved.currentTime : Infinity;
    if (remaining < 0.35) return false;
    a.currentTime = Math.max(0, saved.currentTime - ANSWER_RESUME_REWIND_SEC);
    a.onended = () => scheduleFollowUpResume(); // this resume owns the ended handler now
    setPhase('answering');
    setStatus('answering…');
    fadeIn(a);
    void a.play().catch(() => {});
    return true;
  }, [scheduleFollowUpResume]);

  // The spoken-QA turn: receive the answer stream, play the complete answer
  // audio, then leave a brief follow-up window before resuming narration.
  const handleUtterance = useCallback(async (blob: Blob) => {
    // Supersede any in-flight QA turn (e.g. the user barged in during thinking).
    const gen = ++qaGenRef.current;
    qaAbortRef.current?.abort();
    const abort = new AbortController();
    qaAbortRef.current = abort;
    const stale = () => qaGenRef.current !== gen;
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
          if (stale()) return;
          const question = q || '(…)';
          onQuestion?.(question);
          setTranscript((t) => [...t, { q: question, a: '' }]);
        },
        onAnswer: (a) => {
          if (stale()) return;
          // notify OUTSIDE the state updater — updaters can run twice in
          // StrictMode dev, which double-filled the page transcript
          onAnswer?.(a);
          setTranscript((t) => {
            // fill the answer into the last (matching) question row
            const next = [...t];
            for (let i = next.length - 1; i >= 0; i--) { if (!next[i].a) { next[i] = { ...next[i], a }; break; } }
            return next;
          });
        },
        onBackChannel: () => {
          if (stale()) return;
          setStatus('…go on');
          // false barge mid-answer → finish the answer, not the narration
          if (!resumeInterruptedAnswer()) resumeNarration();
        },
        onPlaybackStart: () => {
          if (stale()) return;
          interruptedAnswerRef.current = null; // a real new answer supersedes the old one
          setPhase('answering');
          setStatus('answering…');
        },
        onEnded: () => { if (!stale()) scheduleFollowUpResume(); },
      }, abort.signal);
      if (stale()) return;
      // Nothing played (back-channel handled above, or empty) → make sure we resume.
      if (!r.backChannel && !r.played) scheduleFollowUpResume();
    } catch (e) {
      if (stale() || (e instanceof DOMException && e.name === 'AbortError')) return;
      setStatus(`(qa error: ${e instanceof Error ? e.message : 'failed'})`);
      if (!resumeInterruptedAnswer()) resumeNarration();
    }
  }, [scenes, resumeInterruptedAnswer, resumeNarration, scheduleFollowUpResume, onQuestion, onAnswer]);

  // Recording starts TENTATIVELY on the first voiced frame, so the head of the
  // question is captured even though the barge-in hasn't been confirmed yet.
  const startRecording = useCallback(() => {
    if (!streamRef.current || recRef.current) return;
    const session = { discard: false };
    recSessionRef.current = session;
    const chunks: Blob[] = [];
    const mimeType = pickMime();
    const rec = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
      if (session.discard) return; // blip / teardown — never reached commit
      const blob = new Blob(chunks, { type: rec.mimeType });
      const dur = Date.now() - recStartRef.current;
      if (dur >= MIN_UTTERANCE_MS && blob.size > 800) void handleUtterance(blob);
      else if (!resumeInterruptedAnswer()) { setStatus('…go on'); resumeNarration(); } // too short → ignore
    };
    recStartRef.current = Date.now();
    rec.start();
    recRef.current = rec;
    tentativeRef.current = true;
  }, [handleUtterance, resumeInterruptedAnswer, resumeNarration]);

  const stopRecording = useCallback(() => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    recRef.current = null;
    tentativeRef.current = false;
  }, []);

  // First voiced frame: duck whatever is playing and start capturing, but don't
  // commit to a barge-in yet. Feels instant without false-positive pauses.
  const beginTentativeBarge = useCallback(() => {
    for (const el of [narrationRef.current, answerRef.current]) {
      if (el && !el.paused && !el.ended) {
        cancelFade(el);
        el.volume = DUCK_VOLUME;
      }
    }
    startRecording();
  }, [startRecording]);

  // The sound stopped before SPEECH_MS: it was a blip. Drop the recorder and
  // ramp the ducked audio back up — playback never actually paused.
  const cancelTentativeBarge = useCallback(() => {
    if (!tentativeRef.current) return;
    tentativeRef.current = false;
    if (recSessionRef.current) recSessionRef.current.discard = true;
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    recRef.current = null;
    for (const el of [narrationRef.current, answerRef.current]) {
      if (el && !el.paused && !el.ended) fadeIn(el, 150);
    }
  }, []);

  // Sustained voice: this is a real barge-in. Pause playback (remembering where
  // it was), cancel any pending resume, and keep the already-running recorder.
  const commitBargeIn = useCallback(() => {
    tentativeRef.current = false;
    speechStartRef.current = 0;
    silenceStartRef.current = 0;
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    const narration = narrationRef.current;
    if (narration && !narration.paused) {
      interruptedNarrationRef.current = {
        idx: sceneIdxRef.current,
        currentTime: narration.currentTime,
      };
      narration.pause();
      cancelFade(narration);
      narration.volume = 1;
    }
    const ans = answerRef.current;
    if (ans && !ans.paused && !ans.ended) {
      interruptedAnswerRef.current = { currentTime: ans.currentTime };
      ans.pause();
      cancelFade(ans);
      ans.volume = 1;
    }
    // Interrupting mid-thinking supersedes the pending answer right away, so it
    // can't start blaring while the user is still asking the new question.
    if (phaseRef.current === 'thinking') qaAbortRef.current?.abort();
    setPhase('listening');
    setStatus('listening…');
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

    const committed = !!recRef.current && !tentativeRef.current;
    if (!committed && ph !== 'off') {
      // Waiting for (or confirming) a barge-in — in EVERY phase, including
      // 'thinking', so the user can talk over the pending answer.
      if (rms > SPEECH_RMS) {
        if (!speechStartRef.current) {
          speechStartRef.current = now;
          beginTentativeBarge(); // duck + capture from the very first frame
        } else if (now - speechStartRef.current >= (ph === 'thinking' ? THINKING_SPEECH_MS : SPEECH_MS)) {
          commitBargeIn();
        }
      } else if (speechStartRef.current) {
        speechStartRef.current = 0;
        cancelTentativeBarge();
      }
    } else if (committed) {
      // Recording a committed question — wait for sustained silence.
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
  }, [beginTentativeBarge, cancelTentativeBarge, commitBargeIn, stopRecording]);

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
    qaAbortRef.current?.abort();
    qaGenRef.current++; // invalidate any in-flight QA callbacks
    if (recSessionRef.current) recSessionRef.current.discard = true; // don't send a partial clip
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

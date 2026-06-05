'use client';

// StepFun storybook tutor — same UI shell as /tutor, but a hybrid backend:
// StepFun generates images + narration audio and provides ASR/TTS; Gemini lite
// answers QA by default because StepFun chat's reasoning latency is too high
// for barge-in turns. Set STEPFUN_QA_LLM=stepfun to force the old all-StepFun
// brain path for comparison.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InputScreen } from '@/components/tutor/InputScreen';
import { LoadingScreen, type LoadingState } from '@/components/tutor/LoadingScreen';
import { ScalingStage } from '@/components/tutor/ScalingStage';
import { StoryScreen } from '@/components/tutor/StoryScreen';
import { T, F_BODY, type Scene as TutorScene } from '@/components/tutor/theme';
import VoiceBargeIn, { type VoiceScene } from './VoiceBargeIn';

interface StepFunScene {
  id: string;
  narration: string;
  imageUrl: string;
  audioDataUrl: string;
}

interface QaTurn {
  q: string;
  a: string;
}

type Stage = 'input' | 'loading' | 'story';
type VoicePhase = 'off' | 'narrating' | 'listening' | 'thinking' | 'answering' | 'paused';

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi'];

const initialLoadingState: LoadingState = {
  scriptDrafted: false,
  scenesComposed: false,
  imagesReady: 0,
  totalScenes: 0,
  allImagesReady: false,
  videosReady: 0,
};

function toTutorScene(scene: StepFunScene, index: number): TutorScene {
  return {
    id: scene.id,
    chapter: `Scene ${index + 1}`,
    sceneNum: ROMAN[index] ?? String(index + 1),
    headline: [`Plate`, ROMAN[index] ?? String(index + 1)],
    narration_text: scene.narration,
    image_prompt: '',
    image_url: scene.imageUrl,
  };
}

function agentStateFromVoice(phase: VoicePhase, typedAsking: boolean) {
  if (typedAsking) return 'thinking';
  if (phase === 'thinking') return 'thinking';
  if (phase === 'listening') return 'listening';
  if (phase === 'answering' || phase === 'narrating') return 'speaking';
  if (phase === 'off') return 'speaking';
  return 'idle';
}

export default function StepFunPage() {
  const [stage, setStage] = useState<Stage>('input');
  const [topic, setTopic] = useState(
    'Tell a short 3-scene bedtime story about a library cat named Pemberley.',
  );
  const [error, setError] = useState<string | null>(null);
  const [scenes, setScenes] = useState<StepFunScene[]>([]);
  const [active, setActive] = useState(0);
  const [qaHistoryByScene, setQaHistoryByScene] = useState<Record<number, QaTurn[]>>({});
  const [typedAsking, setTypedAsking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('off');
  const [micError, setMicError] = useState<string | null>(null);
  const [liveUserText, setLiveUserText] = useState<string | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>(initialLoadingState);

  const typedAudioRef = useRef<HTMLAudioElement | null>(null);
  const interruptedTypedAudioRef = useRef<{ src: string; currentTime: number } | null>(null);
  const pendingVoiceQuestionRef = useRef<{ scene: number; q: string } | null>(null);

  const tutorScenes = useMemo(() => scenes.map(toTutorScene), [scenes]);
  const voiceScenes: VoiceScene[] = useMemo(
    () => scenes.map((s) => ({ id: s.id, narration: s.narration, audioDataUrl: s.audioDataUrl })),
    [scenes],
  );

  useEffect(() => {
    if (stage !== 'loading') return undefined;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - started;
      const totalScenes = 3;
      const imagesReady = Math.min(totalScenes, Math.max(0, Math.floor((elapsed - 2500) / 3500) + 1));
      setLoadingState({
        scriptDrafted: elapsed >= 700,
        scenesComposed: elapsed >= 1500,
        imagesReady,
        totalScenes: elapsed >= 1500 ? totalScenes : 0,
        allImagesReady: imagesReady >= totalScenes,
        videosReady: elapsed >= 15500 ? 1 : 0,
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [stage]);

  const stopTypedAudio = useCallback(() => {
    const a = typedAudioRef.current;
    if (!a) return;
    a.pause();
    a.currentTime = 0;
    interruptedTypedAudioRef.current = null;
  }, []);

  const interruptTypedAudio = useCallback(() => {
    const a = typedAudioRef.current;
    if (!a || a.paused || !a.src) {
      interruptedTypedAudioRef.current = null;
      return;
    }
    interruptedTypedAudioRef.current = { src: a.src, currentTime: a.currentTime };
    a.pause();
  }, []);

  const resumeTypedAudio = useCallback(() => {
    const interrupted = interruptedTypedAudioRef.current;
    interruptedTypedAudioRef.current = null;
    if (!interrupted || !typedAudioRef.current) return;
    const a = typedAudioRef.current;
    a.src = interrupted.src;
    a.currentTime = interrupted.currentTime;
    void a.play().catch(() => {});
  }, []);

  const generate = useCallback(async (input: string) => {
    const payload = input.trim() || topic;
    setTopic(payload);
    setStage('loading');
    setLoadingState(initialLoadingState);
    setError(null);
    setScenes([]);
    setQaHistoryByScene({});
    setLiveUserText(null);
    setMicError(null);
    setVoiceEnabled(false);
    setVoicePhase('off');
    stopTypedAudio();
    try {
      const res = await fetch('/api/stepfun/lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setScenes(data.scenes ?? []);
      setActive(0);
      setStage('story');
      // Match tutor's intended posture: voice-first, always listening. If the
      // browser denies mic access, VoiceBargeIn reports it and the composer
      // shows the retry affordance.
      setVoiceEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      setStage('input');
    }
  }, [stopTypedAudio, topic]);

  const appendQa = useCallback((sceneIndex: number, q: string, a = '') => {
    setQaHistoryByScene((prev) => {
      const next = { ...prev };
      next[sceneIndex] = [...(next[sceneIndex] ?? []), { q, a }];
      return next;
    });
  }, []);

  const fillLatestAnswer = useCallback((sceneIndex: number, answer: string) => {
    setQaHistoryByScene((prev) => {
      const next = { ...prev };
      const turns = [...(next[sceneIndex] ?? [])];
      for (let i = turns.length - 1; i >= 0; i--) {
        if (!turns[i].a) {
          turns[i] = { ...turns[i], a: answer };
          next[sceneIndex] = turns;
          return next;
        }
      }
      next[sceneIndex] = [...turns, { q: '', a: answer }];
      return next;
    });
  }, []);

  const askText = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || typedAsking) return;
    const sceneIndex = active;
    setTypedAsking(true);
    setLiveUserText(null);
    appendQa(sceneIndex, q);
    // Text-mode QA uses the typed audio element. If the user is in voice mode,
    // pause the hidden voice loop first; they can tap the mic back on after the
    // answer. This keeps resume semantics simple and avoids dueling audio.
    setVoiceEnabled(false);
    interruptTypedAudio();
    try {
      const visibleStorySoFar = scenes
        .slice(0, sceneIndex + 1)
        .map((s) => s.narration)
        .join(' ');
      const res = await fetch('/api/stepfun/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, storySoFar: visibleStorySoFar }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const answer = data.answer || 'Let me think about that one.';
      fillLatestAnswer(sceneIndex, answer);
      if (data.audioDataUrl) {
        if (!typedAudioRef.current) typedAudioRef.current = new Audio();
        const a = typedAudioRef.current;
        a.src = data.audioDataUrl;
        a.onended = resumeTypedAudio;
        void a.play().catch(() => {});
      } else {
        resumeTypedAudio();
      }
    } catch (e) {
      fillLatestAnswer(sceneIndex, `(error: ${e instanceof Error ? e.message : 'failed'})`);
      resumeTypedAudio();
    } finally {
      setTypedAsking(false);
    }
  }, [active, appendQa, fillLatestAnswer, interruptTypedAudio, resumeTypedAudio, scenes, typedAsking]);

  const handleVoiceQuestion = useCallback((question: string) => {
    const sceneIndex = active;
    pendingVoiceQuestionRef.current = { scene: sceneIndex, q: question };
    setLiveUserText(null);
    appendQa(sceneIndex, question);
  }, [active, appendQa]);

  const handleVoiceAnswer = useCallback((answer: string) => {
    const pending = pendingVoiceQuestionRef.current;
    const sceneIndex = pending?.scene ?? active;
    pendingVoiceQuestionRef.current = null;
    fillLatestAnswer(sceneIndex, answer);
  }, [active, fillLatestAnswer]);

  if (stage === 'input') {
    return (
      <>
        <InputScreen onBegin={generate} initialText={topic} />
        {error && (
          <div
            style={{
              position: 'fixed',
              left: '50%',
              bottom: 28,
              transform: 'translateX(-50%)',
              maxWidth: 640,
              background: T.paperHi,
              border: `1px solid ${T.rose}`,
              color: T.ink,
              padding: '12px 16px',
              fontFamily: F_BODY,
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}
      </>
    );
  }

  if (stage === 'loading') {
    return (
      <ScalingStage>
        <LoadingScreen state={loadingState} />
      </ScalingStage>
    );
  }

  return (
    <ScalingStage>
      <StoryScreen
        scenes={tutorScenes}
        activeSceneIndex={Math.min(active, Math.max(0, tutorScenes.length - 1))}
        inBranch={typedAsking || voicePhase === 'listening' || voicePhase === 'thinking' || voicePhase === 'answering'}
        finished={voicePhase === 'paused' && active >= scenes.length}
        liveNarrationText={tutorScenes[active]?.narration_text ?? null}
        liveUserText={liveUserText}
        qaHistoryByScene={qaHistoryByScene}
        micDenied={!!micError}
        micMuted={!voiceEnabled}
        micLevel={voicePhase === 'listening' ? 0.55 : 0}
        agentState={agentStateFromVoice(voicePhase, typedAsking)}
        onToggleMic={() => {
          setMicError(null);
          setVoiceEnabled((v) => !v);
        }}
        onTextQuestion={askText}
        onExit={() => {
          setVoiceEnabled(false);
          stopTypedAudio();
          setStage('input');
        }}
      />
      <VoiceBargeIn
        scenes={voiceScenes}
        enabled={voiceEnabled && scenes.length > 0}
        hideControls
        onPhaseChange={(phase) => setVoicePhase(phase)}
        onSceneChange={setActive}
        onQuestion={handleVoiceQuestion}
        onAnswer={handleVoiceAnswer}
        onMicError={(msg) => {
          setMicError(msg);
          if (msg) setVoiceEnabled(false);
        }}
      />
    </ScalingStage>
  );
}

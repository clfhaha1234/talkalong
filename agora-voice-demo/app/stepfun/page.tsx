'use client';

// StepFun storybook tutor — standalone /stepfun. Proves the full StepFun stack:
// story (step-3.7-flash) → scene images (step-image-edit-2) → narration audio
// (step-tts-2), plus typed Q&A. The realtime barge-in voice loop is added on top
// of this (next phase). No Agora — entirely StepFun.

import { useRef, useState } from 'react';
import VoiceBargeIn from './VoiceBargeIn';

interface Scene {
  id: string;
  narration: string;
  imageUrl: string;
  audioDataUrl: string;
}
interface QaTurn {
  q: string;
  a: string;
}

export default function StepFunPage() {
  const [topic, setTopic] = useState(
    'Tell a short 3-scene bedtime story about a library cat named Pemberley.',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [active, setActive] = useState(0);
  const [question, setQuestion] = useState('');
  const [qa, setQa] = useState<QaTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const interruptedAudioRef = useRef<{ src: string; currentTime: number } | null>(null);

  const play = (src: string) => {
    if (!src) return;
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.onended = null;
    audioRef.current.src = src;
    void audioRef.current.play().catch(() => {});
  };

  const stopCurrentAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    interruptedAudioRef.current = null;
  };

  const interruptCurrentAudio = () => {
    const a = audioRef.current;
    if (!a || a.paused || !a.src) {
      interruptedAudioRef.current = null;
      return;
    }
    interruptedAudioRef.current = { src: a.src, currentTime: a.currentTime };
    a.pause();
  };

  const resumeInterruptedAudio = () => {
    const interrupted = interruptedAudioRef.current;
    interruptedAudioRef.current = null;
    if (!interrupted || !audioRef.current) return;
    const a = audioRef.current;
    a.src = interrupted.src;
    a.currentTime = interrupted.currentTime;
    void a.play().catch(() => {});
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    setScenes([]);
    setQa([]);
    stopCurrentAudio();
    try {
      const res = await fetch('/api/stepfun/lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setScenes(data.scenes);
      setActive(0);
      if (data.scenes[0]?.audioDataUrl) play(data.scenes[0].audioDataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  };

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setQuestion('');
    interruptCurrentAudio();
    try {
      const visibleStorySoFar = scenes
        .slice(0, active + 1)
        .map((s) => s.narration)
        .join(' ');
      const res = await fetch('/api/stepfun/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, storySoFar: visibleStorySoFar }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setQa((prev) => [...prev, { q, a: data.answer }]);
      if (data.audioDataUrl) {
        if (!audioRef.current) audioRef.current = new Audio();
        const a = audioRef.current;
        a.src = data.audioDataUrl;
        a.onended = resumeInterruptedAudio;
        void a.play().catch(() => {});
      } else {
        resumeInterruptedAudio();
      }
    } catch (e) {
      setQa((prev) => [...prev, { q, a: `(error: ${e instanceof Error ? e.message : 'failed'})` }]);
      resumeInterruptedAudio();
    } finally {
      setAsking(false);
    }
  };

  const scene = scenes[active];

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: 24, fontFamily: 'Georgia, serif', color: '#3a2f28' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>StepFun Storybook</h1>
      <p style={{ fontSize: 13, color: '#8a7d72', marginTop: 0 }}>
        story + image + narration + Q&amp;A — all on StepFun (阶跃星辰). No Agora.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="A topic for a 3-scene story…"
          style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #d8cfc4', fontSize: 14 }}
        />
        <button
          onClick={generate}
          disabled={loading}
          style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#4a3f36', color: '#fff', cursor: 'pointer' }}
        >
          {loading ? 'Generating…' : 'Begin'}
        </button>
      </div>

      {error && <p style={{ color: '#b00020' }}>⚠ {error}</p>}

      {scene && (
        <div>
          {scene.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={scene.imageUrl} alt={scene.id} style={{ width: '100%', borderRadius: 12, display: 'block' }} />
          ) : (
            <div style={{ padding: 40, textAlign: 'center', background: '#f3ece3', borderRadius: 12 }}>(no image)</div>
          )}
          <p style={{ fontSize: 17, lineHeight: 1.6, marginTop: 14 }}>{scene.narration}</p>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 20px' }}>
            {scenes.map((s, i) => (
              <button
                key={s.id}
                onClick={() => { setActive(i); play(s.audioDataUrl); }}
                style={{ width: 28, height: 28, borderRadius: 14, border: '1px solid #d8cfc4', background: i === active ? '#4a3f36' : '#fff', color: i === active ? '#fff' : '#4a3f36', cursor: 'pointer' }}
              >
                {i + 1}
              </button>
            ))}
            <button onClick={() => play(scene.audioDataUrl)} style={{ marginLeft: 8, padding: '4px 10px', borderRadius: 8, border: '1px solid #d8cfc4', background: '#fff', cursor: 'pointer' }}>
              ▶ replay narration
            </button>
          </div>

          <div style={{ borderTop: '1px solid #ece4d9', paddingTop: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
                placeholder="Ask the storyteller a question…"
                style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #d8cfc4', fontSize: 14 }}
              />
              <button onClick={ask} disabled={asking} style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#6a5a4c', color: '#fff', cursor: 'pointer' }}>
                {asking ? '…' : 'Ask'}
              </button>
            </div>
            {qa.map((t, i) => (
              <div key={i} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 14, color: '#8a7d72' }}>You: {t.q}</div>
                <div style={{ fontSize: 15 }}>📖 {t.a}</div>
              </div>
            ))}
          </div>

          {/* Realtime voice mode: narration + speak-to-interrupt (barge-in). */}
          <VoiceBargeIn scenes={scenes} />
        </div>
      )}
    </main>
  );
}

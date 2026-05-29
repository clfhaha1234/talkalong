// Story screen — auto-paging book spread with mic-driven QA interrupt.

const ST = window.PrototypeShared;
const { T: TT, F_HEAD: FH, F_BODY: FB, F_MONO: FM, Flourish: FlourishS, CornerOrn: CornerOrnS,
        MicIcon: MicIconS, PauseIcon: PauseIconS, PlayIcon: PlayIconS, SCENES: SCENES_S, tokenize: tok } = ST;

const { useEffect: usE, useState: usS, useRef: usR, useMemo: usM, useCallback: usC } = React;

// Words per second for narration reveal
const WPS = 4.2;

// ──────────────────────────────────────────────────────────────
// Sample Q&A pairs — picked based on the current scene
const QA_BANK = [
  { q: 'Wait — what if I run faster than light?',
    a: "Wonderful question. It turns out you can't. As you try to go faster, your mass behaves as if it grew heavier, and heavier, and heavier still. To reach light's speed you'd need infinite push. So light keeps its head start — forever." },
  { q: 'So an astronaut is really younger when they come back?',
    a: "Yes, by a tiny, tiny amount. The astronauts on the Space Station age about 0.007 seconds less than us, after six months in orbit. Not enough to notice — but real, and measured, and proven." },
  { q: 'Why does light always go the same speed?',
    a: "Nobody fully knows why. But every experiment we've ever done agrees that it does. Einstein took that one stubborn fact and asked, 'If this is true, what must everything else look like?' That question gave us relativity." },
  { q: 'Can I ask it to repeat the last bit?',
    a: "Of course. Just say 'repeat that' or tap the back arrow — we'll re-read the last page together before we go on." },
  { q: 'What does the c stand for?',
    a: "It comes from the Latin word celeritas — meaning swiftness. So when we write c, we're really writing 'the swiftness' — the fastest swiftness there is." },
];

// Pick a Q&A loosely matched to scene index
function pickQA(sceneIndex, used) {
  const idx = (sceneIndex + used) % QA_BANK.length;
  return QA_BANK[idx];
}

// ──────────────────────────────────────────────────────────────
// Mic waveform — simple animated bars
function Waveform({ active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 22 }}>
      {[0,1,2,3,4,5,6,7,8].map(i => (
        <div key={i} style={{
          width: 3, height: '100%', background: TT.rose, borderRadius: 2,
          opacity: 0.8,
          animation: active ? `wave ${0.6 + (i % 3) * 0.15}s ease-in-out ${i * 0.08}s infinite` : 'none',
          transformOrigin: 'center',
          transform: 'scaleY(0.2)',
        }} />
      ))}
      <style>{`@keyframes wave { 0%,100% { transform: scaleY(0.2);} 50% { transform: scaleY(1);} }`}</style>
    </div>
  );
}

// Scene thumbnail strip — at the bottom for navigation
function SceneStrip({ count, current, onJump }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <button key={i}
          onClick={() => onJump(i)}
          style={{
            width: 22, height: 6, border: 'none', cursor: 'pointer',
            background: i < current ? TT.sage : (i === current ? TT.rose : TT.paperEdge),
            borderRadius: 0, padding: 0,
            transition: 'background 0.2s',
          }} />
      ))}
    </div>
  );
}

// Single book "page" with progressive narration
function BookSpread({ scene, narrationVisible, paused, qaState, currentQA, qaHistory }) {
  const { Illustration, chapter, sceneNum, headline, narration } = scene;
  const tokens = usM(() => tok(narration), [narration]);
  // visible chunk of tokens
  const visible = tokens.slice(0, narrationVisible).join('');
  const remaining = tokens.slice(narrationVisible).join('');

  return (
    <div style={{
      position: 'absolute', top: 60, left: 50, right: 50, bottom: 130,
      display: 'grid', gridTemplateColumns: '1.05fr 1px 1fr',
      background: TT.paperHi, border: `1px solid ${TT.paperEdge}`,
      boxShadow: '0 14px 40px rgba(60,40,20,0.10), 0 2px 0 rgba(60,40,20,0.04)',
    }}>
      {/* page header — chapter ribbon */}
      <div style={{
        position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)',
        background: TT.paper, padding: '4px 22px', fontFamily: FH, fontStyle: 'italic',
        fontSize: 14, color: TT.inkSoft, letterSpacing: '0.15em', border: `1px solid ${TT.paperEdge}`,
        borderRadius: 999,
      }}>
        {chapter}
      </div>

      {/* LEFT — illustration */}
      <div style={{ padding: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <div style={{ width: '100%', aspectRatio: '1/1', maxHeight: 460 }}>
          <Illustration />
        </div>
        {/* caption */}
        <div style={{
          position: 'absolute', bottom: 12, left: 0, right: 0, textAlign: 'center',
          fontFamily: FH, fontStyle: 'italic', fontSize: 13, color: TT.inkWhisper, letterSpacing: '0.06em',
        }}>
          — plate {scene.plateNum || 'iii'} —
        </div>
      </div>

      {/* spine */}
      <div style={{ background: `linear-gradient(180deg, transparent, ${TT.paperEdge} 20%, ${TT.paperEdge} 80%, transparent)` }} />

      {/* RIGHT — text */}
      <div style={{ padding: '48px 50px 32px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ fontSize: 12, letterSpacing: '0.25em', color: TT.rose, textTransform: 'uppercase', fontFamily: FM }}>
          {sceneNum}
        </div>
        <h3 style={{
          fontFamily: FH, fontStyle: 'italic', fontWeight: 500, fontSize: 38,
          margin: '12px 0 14px', lineHeight: 1.1, letterSpacing: '-0.01em',
        }}>
          {headline[0]}<br />{headline[1]}
        </h3>
        <FlourishS size={48} />

        <div style={{
          marginTop: 18, fontFamily: FH, fontSize: 19, lineHeight: 1.65,
          color: TT.ink, minHeight: 160, flex: 1,
        }}>
          {visible}
          {!paused && narrationVisible < tokens.length && (
            <span style={{
              display: 'inline-block', width: 2, height: 19, background: TT.rose,
              verticalAlign: -3, marginLeft: 1, animation: 'blink 0.9s infinite',
            }} />
          )}
          <span style={{ color: 'transparent' }}>{remaining}</span>
        </div>

        {/* QA inline after narration */}
        {qaHistory.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px dashed ${TT.paperEdge}` }}>
            {qaHistory.map((qa, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div style={{
                  fontFamily: FM, fontSize: 10, letterSpacing: '0.25em',
                  color: TT.rose, marginBottom: 3,
                }}>
                  YOU ASKED
                </div>
                <div style={{
                  fontFamily: FH, fontStyle: 'italic', fontSize: 16,
                  color: TT.inkSoft, lineHeight: 1.5,
                }}>
                  "{qa.q}"
                </div>
                <div style={{
                  fontFamily: FM, fontSize: 10, letterSpacing: '0.25em',
                  color: TT.sage, margin: '8px 0 3px',
                }}>
                  TEACHER · {qa.qNum}
                </div>
                <div style={{ fontFamily: FH, fontSize: 16, lineHeight: 1.55, color: TT.ink }}>
                  {qa.a}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }`}</style>
    </div>
  );
}

// QA composer — appears in footer when mic is active
function QAComposer({ qaState, transcript, setTranscript, onSubmit, onCancel, currentReply }) {
  const inputRef = usR(null);
  usE(() => {
    if (qaState === 'listening' && inputRef.current) inputRef.current.focus();
  }, [qaState]);

  return (
    <div style={{
      position: 'absolute', bottom: 116, left: 50, right: 50,
      background: TT.paperHi, border: `1px solid ${TT.rose}`,
      padding: '16px 22px',
      boxShadow: '0 -2px 0 rgba(199,123,106,0.1), 0 12px 30px rgba(60,40,20,0.10)',
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* listening header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Waveform active={qaState === 'listening'} />
          <div style={{
            fontFamily: FH, fontStyle: 'italic', fontSize: 15, color: TT.rose,
            letterSpacing: '0.05em',
          }}>
            {qaState === 'listening' && '· Listening — go ahead, ask anything ·'}
            {qaState === 'thinking' && '· The teacher is thinking …'}
            {qaState === 'replied'  && '· Read the answer below, then resume when you are ready ·'}
          </div>
        </div>
        <button onClick={onCancel} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: FH, fontStyle: 'italic', fontSize: 14, color: TT.inkSoft,
        }}>
          ✕ never mind
        </button>
      </div>

      {qaState === 'listening' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            ref={inputRef}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && transcript.trim()) onSubmit(); }}
            placeholder="Type or speak your question…"
            style={{
              flex: 1, border: 'none', borderBottom: `1px solid ${TT.paperEdge}`,
              padding: '8px 2px', fontFamily: FH, fontStyle: 'italic', fontSize: 18,
              background: 'transparent', color: TT.ink, outline: 'none',
            }}
          />
          <button
            onClick={onSubmit}
            disabled={!transcript.trim()}
            style={{
              background: transcript.trim() ? TT.ink : TT.paperEdge,
              color: TT.paper, border: 'none',
              padding: '8px 18px', fontFamily: FH, fontStyle: 'italic', fontSize: 15,
              cursor: transcript.trim() ? 'pointer' : 'default',
              borderRadius: 2,
            }}>
            Ask  →
          </button>
        </div>
      )}

      {qaState === 'thinking' && (
        <div style={{ fontFamily: FH, fontStyle: 'italic', fontSize: 17, color: TT.inkSoft }}>
          "{transcript}"
          <span style={{ marginLeft: 8 }}>
            <span style={{ animation: 'dots 1.2s steps(3) infinite', display: 'inline-block', width: 18 }}>...</span>
          </span>
          <style>{`@keyframes dots {0%{content:'.'}33%{content:'..'}66%{content:'...'}}`}</style>
        </div>
      )}

      {qaState === 'replied' && currentReply && (
        <div>
          <div style={{
            fontFamily: FM, fontSize: 10, letterSpacing: '0.25em', color: TT.rose, marginBottom: 4,
          }}>
            YOU
          </div>
          <div style={{ fontFamily: FH, fontStyle: 'italic', fontSize: 16, color: TT.inkSoft, marginBottom: 12 }}>
            "{currentReply.q}"
          </div>
          <div style={{
            fontFamily: FM, fontSize: 10, letterSpacing: '0.25em', color: TT.sage, marginBottom: 4,
          }}>
            THE TEACHER
          </div>
          <div style={{ fontFamily: FH, fontSize: 17, lineHeight: 1.6, color: TT.ink }}>
            {currentReply.a}
          </div>
        </div>
      )}
    </div>
  );
}

// FOOTER controls — chapter strip + mic + side controls
function StoryFooter({
  sceneIndex, sceneCount, paused, qaState,
  onPrev, onNext, onJump, onTogglePlay, onMicClick, onResume,
}) {
  const micActive = qaState !== 'idle';
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, height: 110,
      borderTop: `1px solid ${TT.paperEdge}`, background: TT.paper,
      padding: '0 50px',
      display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center',
    }}>
      {/* Left — chapter strip */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SceneStrip count={sceneCount} current={sceneIndex} onJump={onJump} />
        <div style={{ fontFamily: FM, fontSize: 11, letterSpacing: '0.18em', color: TT.inkSoft }}>
          PAGE {String(sceneIndex + 1).padStart(2, '0')} · OF · {String(sceneCount).padStart(2, '0')}
        </div>
      </div>

      {/* Middle — playback */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onPrev} style={iconBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M 9 2 L 4 7 L 9 12" stroke={TT.ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {!micActive ? (
          <button onClick={onTogglePlay} style={{ ...iconBtn, width: 44, height: 44 }}>
            {paused ? <PlayIconS color={TT.ink} /> : <PauseIconS color={TT.ink} />}
          </button>
        ) : null}

        {/* Mic — or "resume" when replied */}
        {qaState === 'replied' ? (
          <button onClick={onResume} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: TT.sage, color: TT.paper, border: 'none',
            padding: '14px 24px', fontFamily: FH, fontStyle: 'italic', fontSize: 17,
            cursor: 'pointer', borderRadius: 999,
            boxShadow: '0 4px 12px rgba(139,157,126,0.3)',
          }}>
            <PlayIconS color={TT.paper} size={14} />
            Resume the story
          </button>
        ) : (
          <button
            onClick={onMicClick}
            style={{
              width: 64, height: 64, borderRadius: '50%',
              background: micActive ? TT.rose : TT.ink,
              color: TT.paper, border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: micActive
                ? `0 0 0 6px rgba(199,123,106,0.18), 0 0 0 14px rgba(199,123,106,0.08)`
                : '0 4px 12px rgba(60,40,20,0.18)',
              position: 'relative', transition: 'all 0.2s',
            }}>
            <MicIconS color={TT.paper} size={22} />
          </button>
        )}

        <button onClick={onNext} style={iconBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M 5 2 L 10 7 L 5 12" stroke={TT.ink} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Right — instructions */}
      <div style={{
        fontFamily: FH, fontStyle: 'italic', fontSize: 14, color: TT.inkSoft, textAlign: 'right',
      }}>
        {qaState === 'idle' && (paused
          ? 'Reading is paused · tap play to continue'
          : 'Tap the microphone anytime — I will stop and listen')}
        {qaState === 'listening' && 'Press Enter to send · or ✕ to cancel'}
        {qaState === 'thinking' && 'Just a thought …'}
        {qaState === 'replied' && 'Tap resume when you are ready to read on'}
      </div>
    </div>
  );
}

const iconBtn = {
  width: 36, height: 36, borderRadius: '50%',
  border: `1px solid ${TT.paperEdge}`, background: TT.paperHi,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// ──────────────────────────────────────────────────────────────
// MAIN story screen
function StoryScreen({ topic, onExit }) {
  const [sceneIndex, setSceneIndex] = usS(0);
  const [narrationVisible, setNarrationVisible] = usS(0);
  const [paused, setPaused] = usS(false);
  const [qaState, setQaState] = usS('idle'); // 'idle' | 'listening' | 'thinking' | 'replied'
  const [transcript, setTranscript] = usS('');
  const [currentReply, setCurrentReply] = usS(null);
  const [qaHistoryByScene, setQaHistoryByScene] = usS({}); // sceneIdx -> [{q,a}]
  const [pageKey, setPageKey] = usS(0); // for replaying illustration animations

  const scene = SCENES_S[sceneIndex];
  const sceneTokens = usM(() => tok(scene.narration), [scene]);
  const sceneTokenCount = sceneTokens.length;

  // Tick the narration words
  usE(() => {
    if (paused || qaState !== 'idle') return;
    if (narrationVisible >= sceneTokenCount) {
      // hold a beat then advance
      const t = setTimeout(() => {
        if (sceneIndex < SCENES_S.length - 1) {
          setSceneIndex(i => i + 1);
          setNarrationVisible(0);
          setPageKey(k => k + 1);
        }
      }, 2400);
      return () => clearTimeout(t);
    }
    // 1 token roughly every (1/WPS) seconds. Tokens are word+space pairs so step by 2.
    const intervalMs = 1000 / WPS / 2;
    const id = setInterval(() => {
      setNarrationVisible(v => Math.min(sceneTokenCount, v + 1));
    }, intervalMs);
    return () => clearInterval(id);
  }, [paused, qaState, narrationVisible, sceneTokenCount, sceneIndex]);

  // When scene changes, reset reveal and key
  const goto = usC((idx) => {
    const clamped = Math.max(0, Math.min(SCENES_S.length - 1, idx));
    setSceneIndex(clamped);
    setNarrationVisible(0);
    setPageKey(k => k + 1);
  }, []);

  const onMicClick = usC(() => {
    setPaused(true);
    setQaState('listening');
    setTranscript('');
    setCurrentReply(null);
  }, []);

  const onCancel = usC(() => {
    setQaState('idle');
    setPaused(false);
    setTranscript('');
    setCurrentReply(null);
  }, []);

  const usedSoFar = (qaHistoryByScene[sceneIndex] || []).length;

  const onSubmit = usC(() => {
    if (!transcript.trim()) return;
    setQaState('thinking');
    // simulated thinking delay
    setTimeout(() => {
      const matched = pickQA(sceneIndex, usedSoFar);
      const reply = { q: transcript, a: matched.a };
      setCurrentReply(reply);
      setQaState('replied');
    }, 1400);
  }, [transcript, sceneIndex, usedSoFar]);

  const onResume = usC(() => {
    if (currentReply) {
      const qNum = (qaHistoryByScene[sceneIndex] || []).length + 1;
      const enriched = {
        ...currentReply,
        qNum: ['no.1','no.2','no.3','no.4'][qNum - 1] || `no.${qNum}`,
      };
      setQaHistoryByScene(h => ({
        ...h,
        [sceneIndex]: [...(h[sceneIndex] || []), enriched],
      }));
    }
    setCurrentReply(null);
    setTranscript('');
    setQaState('idle');
    setPaused(false);
  }, [currentReply, sceneIndex, qaHistoryByScene]);

  return (
    <div style={{
      position: 'absolute', inset: 0, background: TT.paper, color: TT.ink,
      fontFamily: FB, overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', inset: 0, background: TT.paperTexture, pointerEvents: 'none' }} />
      <CornerOrnS pos="tl" inset={20} />
      <CornerOrnS pos="tr" inset={20} />
      <CornerOrnS pos="bl" inset={20} />
      <CornerOrnS pos="br" inset={20} />

      {/* Top bar */}
      <div style={{
        position: 'absolute', top: 22, left: 50, right: 50,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontFamily: FM, fontSize: 11, letterSpacing: '0.22em', color: TT.inkSoft,
      }}>
        <button onClick={onExit} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: FH, fontStyle: 'italic', fontSize: 14, color: TT.inkSoft,
          padding: 0,
        }}>
          ← back to start
        </button>
        <div style={{ fontFamily: FH, fontStyle: 'italic', color: TT.ink, fontSize: 15, letterSpacing: 0 }}>
          On Relativity, & The Stretching of Time
        </div>
        <div>
          {qaState === 'idle' && !paused && '· now reading ·'}
          {qaState === 'idle' && paused && '· paused ·'}
          {qaState !== 'idle' && '· paused for question ·'}
        </div>
      </div>

      {/* Book spread */}
      <div key={pageKey}>
        <BookSpread
          scene={scene}
          narrationVisible={narrationVisible}
          paused={paused || qaState !== 'idle'}
          qaState={qaState}
          currentQA={currentReply}
          qaHistory={qaHistoryByScene[sceneIndex] || []}
        />
      </div>

      {/* QA composer overlay */}
      {qaState !== 'idle' && (
        <QAComposer
          qaState={qaState}
          transcript={transcript}
          setTranscript={setTranscript}
          onSubmit={onSubmit}
          onCancel={onCancel}
          currentReply={currentReply}
        />
      )}

      {/* Footer */}
      <StoryFooter
        sceneIndex={sceneIndex}
        sceneCount={SCENES_S.length}
        paused={paused}
        qaState={qaState}
        onPrev={() => goto(sceneIndex - 1)}
        onNext={() => goto(sceneIndex + 1)}
        onJump={(i) => goto(i)}
        onTogglePlay={() => setPaused(p => !p)}
        onMicClick={onMicClick}
        onResume={onResume}
      />
    </div>
  );
}

window.PrototypeScreens = Object.assign(window.PrototypeScreens || {}, { StoryScreen });

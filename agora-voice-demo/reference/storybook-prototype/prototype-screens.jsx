// Screens: Input + Loading + Story (with mic interrupt)

const { T, F_HEAD, F_BODY, F_MONO, Flourish, CornerOrn, MicIcon, PauseIcon, PlayIcon, SCENES, tokenize } = window.PrototypeShared;
const { useEffect: uE, useState: uS, useRef: uR, useMemo: uM, useCallback: uC } = React;

const PRESETS = [
  { title: "Einstein's Relativity", sub: 'why time stretches when you run',  prefill: "Tell me the story of Einstein's special relativity — how he figured out that time can stretch and bend. Aim it at a curious 10-year-old." },
  { title: 'Why we have seasons', sub: 'a tilted earth, a year of light', prefill: "Explain to a 9-year-old why the earth has seasons. Use the idea of the tilt of the earth's axis." },
  { title: 'Photosynthesis', sub: 'how a leaf eats sunlight', prefill: "Tell me the story of photosynthesis as if a leaf were telling it to a curious kid. Include sunlight, water, CO₂ and sugar." },
  { title: 'The Little Prince · Ch. 4', sub: 'a sad chapter about numbers', prefill: "Read me Chapter 4 of The Little Prince — the one about grown-ups and numbers. Tell it slowly, like a bedtime story." },
  { title: 'The Black Death', sub: 'a plague that changed Europe', prefill: "Tell me how the Black Death changed medieval Europe, and how it eventually helped lead to the Renaissance." },
];

// ──────────────────────────────────────────────────────────────
// INPUT SCREEN — minimal landing for the demo
function InputScreen({ onBegin }) {
  const [text, setText] = uS('');

  return (
    <div style={{
      position: 'absolute', inset: 0, background: T.paper, color: T.ink,
      fontFamily: F_BODY, overflow: 'auto',
    }}>
      <div style={{ position: 'absolute', inset: 0, background: T.paperTexture, pointerEvents: 'none' }} />

      {/* Tiny brand top-left */}
      <div style={{
        position: 'absolute', top: 32, left: 40,
        fontSize: 11, letterSpacing: '0.35em', color: T.inkSoft, textTransform: 'uppercase',
      }}>
        The · AI · Teacher
      </div>

      <div style={{
        maxWidth: 640, margin: '0 auto', padding: '180px 40px 60px',
        position: 'relative', textAlign: 'center',
      }}>
        {/* Headline */}
        <h1 style={{
          fontFamily: F_HEAD, fontWeight: 500, fontStyle: 'italic',
          fontSize: 56, lineHeight: 1.1, margin: 0, letterSpacing: '-0.005em',
        }}>
          What shall we <span style={{ color: T.rose }}>learn</span> tonight?
        </h1>

        {/* Input — soft card, no tabs */}
        <div style={{
          marginTop: 40, textAlign: 'left', position: 'relative',
          background: T.paperHi, border: `1px solid ${T.paperEdge}`,
          borderRadius: 4, padding: '18px 20px 12px',
          boxShadow: '0 8px 24px rgba(60,40,20,0.05)',
        }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a paper, type a topic, or drop a file…"
            style={{
              display: 'block', width: '100%', minHeight: 100, border: 'none', resize: 'none',
              background: 'transparent', color: T.ink,
              fontFamily: F_HEAD, fontSize: 21, lineHeight: 1.5,
              outline: 'none', fontStyle: text ? 'normal' : 'italic',
              padding: 0,
            }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.paperEdge}`,
          }}>
            <div style={{ fontSize: 12, color: T.inkWhisper, fontFamily: F_HEAD, fontStyle: 'italic' }}>
              · or drop a PDF anywhere
            </div>
            <button
              onClick={() => onBegin(text || PRESETS[0].prefill)}
              style={{
                background: T.ink, color: T.paper, border: 'none',
                padding: '10px 22px', fontFamily: F_HEAD, fontStyle: 'italic',
                fontSize: 16, cursor: 'pointer', letterSpacing: '0.04em',
                borderRadius: 2,
              }}>
              Begin  →
            </button>
          </div>
        </div>

        {/* Preset chips */}
        <div style={{ marginTop: 36, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 12, color: T.inkSoft, fontFamily: F_HEAD, fontStyle: 'italic',
            alignSelf: 'center', marginRight: 4,
          }}>or try:</span>
          {PRESETS.slice(0, 3).map((p, i) => (
            <button key={i}
              onClick={() => onBegin(p.prefill)}
              style={{
                background: 'transparent', cursor: 'pointer',
                border: `1px solid ${T.paperEdge}`, borderRadius: 999,
                padding: '6px 14px', fontFamily: F_HEAD, fontStyle: 'italic',
                fontSize: 14, color: T.ink, letterSpacing: '0.01em',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.rose; e.currentTarget.style.color = T.rose; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.paperEdge; e.currentTarget.style.color = T.ink; }}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// LOADING SCREEN
function LoadingScreen({ onDone }) {
  const STEP_NAMES = [
    { label: 'Reading your material',     sub: 'Skimming for the good parts' },
    { label: 'Drafting the story script', sub: 'Picking the through-line' },
    { label: 'Composing the scenes',      sub: 'Breaking it into pages' },
    { label: 'Sketching each illustration', sub: 'Page-by-page, in ink and wash' },
  ];

  const [step, setStep] = uS(0); // 0..3 in progress, 4 = done
  const [progress, setProgress] = uS(0); // 0..1

  uE(() => {
    if (step >= STEP_NAMES.length) {
      const t = setTimeout(onDone, 700);
      return () => clearTimeout(t);
    }
    // each step gets ~1.8s of work
    const STEP_MS = step === 2 ? 2400 : 1800; // pretend scene composition is slow
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - start;
      const p = Math.min(1, elapsed / STEP_MS);
      setProgress((step + p) / STEP_NAMES.length);
      if (p >= 1) {
        setStep(s => s + 1);
        clearInterval(id);
      }
    }, 60);
    return () => clearInterval(id);
  }, [step, onDone]);

  return (
    <div style={{
      position: 'absolute', inset: 0, background: T.paper, color: T.ink,
      fontFamily: F_BODY,
    }}>
      <div style={{ position: 'absolute', inset: 0, background: T.paperTexture, pointerEvents: 'none' }} />
      <CornerOrn pos="tl" /> <CornerOrn pos="tr" /> <CornerOrn pos="bl" /> <CornerOrn pos="br" />

      <div style={{ position: 'absolute', top: '15%', left: 0, right: 0, textAlign: 'center' }}>
        <Flourish size={70} />
        <h2 style={{
          fontFamily: F_HEAD, fontStyle: 'italic', fontWeight: 500,
          fontSize: 44, margin: '20px 0 8px',
        }}>
          Preparing tonight's lesson
        </h2>
        <p style={{ fontFamily: F_HEAD, fontStyle: 'italic', color: T.inkSoft, fontSize: 16, margin: 0 }}>
          Just a moment while I draft your story —
        </p>
      </div>

      <div style={{
        position: 'absolute', top: '38%', left: '50%', transform: 'translateX(-50%)',
        width: 'min(640px, 80vw)',
        background: T.paperHi, border: `1px solid ${T.paperEdge}`, borderRadius: 4,
        padding: '32px 40px',
        boxShadow: '0 12px 30px rgba(60,40,20,0.06)',
      }}>
        {STEP_NAMES.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 18,
              padding: '14px 0',
              borderBottom: i < STEP_NAMES.length - 1 ? `1px solid ${T.paperEdge}` : 'none',
              transition: 'opacity 0.3s', opacity: done || active ? 1 : 0.55,
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                border: `1.5px solid ${done ? T.sage : (active ? T.rose : T.paperEdge)}`,
                background: done ? T.sage : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'all 0.3s',
              }}>
                {done && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M 3 7 L 6 10 L 11 4" stroke={T.paper} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {active && (
                  <div style={{
                    width: 10, height: 10, borderRadius: '50%', background: T.rose,
                    animation: 'pulse 1.2s ease-in-out infinite',
                  }} />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: F_HEAD, fontSize: 20,
                  fontStyle: active ? 'italic' : 'normal',
                  color: done || active ? T.ink : T.inkSoft,
                }}>{s.label}</div>
                <div style={{ fontSize: 12, color: T.inkSoft, fontStyle: 'italic', marginTop: 2, letterSpacing: '0.06em' }}>
                  {s.sub}
                </div>
              </div>
              {active && (
                <div style={{
                  fontSize: 13, color: T.rose, fontStyle: 'italic',
                  fontFamily: F_HEAD,
                }}>
                  in progress …
                </div>
              )}
              {done && (
                <div style={{ fontSize: 12, color: T.sage, fontFamily: F_MONO, letterSpacing: '0.15em' }}>
                  ✓ DONE
                </div>
              )}
            </div>
          );
        })}

        {/* progress bar */}
        <div style={{ marginTop: 24, height: 3, background: T.paperEdge, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${progress * 100}%`, height: '100%', background: T.rose, transition: 'width 0.2s linear' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: T.inkSoft, fontFamily: F_MONO, letterSpacing: '0.15em', textAlign: 'center' }}>
          { step >= STEP_NAMES.length ? 'READY ·' : `${Math.round(progress * 100)}% ·`}{' '}
          { step >= STEP_NAMES.length ? 'turning the page' : 'about a moment more' }
        </div>
      </div>

      <style>{`@keyframes pulse {0%,100%{transform:scale(1);opacity:1}50%{transform:scale(0.7);opacity:0.5}}`}</style>
    </div>
  );
}

window.PrototypeScreens = { InputScreen, LoadingScreen };

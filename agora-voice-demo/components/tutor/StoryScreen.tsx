// Story stage — book-spread reader with word-by-word narration reveal and
// mic-driven QA interrupt. Ported from prototype-story.jsx with three
// differences from the prototype:
//
//   1. Illustrations are <img src={scene.image_url} /> instead of inline SVG
//      components (the URLs arrive from the SSE `image_ready` events).
//   2. Word reveal advances at ~4.2 WPS purely visually. We do NOT block on
//      `segment_started/completed`; instead, when `segment_completed` for
//      scene N arrives, the parent flips activeSceneIndex to N+1 and we
//      restart reveal on the new scene's text.
//   3. The mic button toggles the local AgoraRTC microphone track via the
//      mic helpers passed in via props. The real BRANCH transition is driven
//      by Agora's VAD on the server side, not by our click handler — but the
//      visual pause + QA composer overlay tracks `inBranch` which the parent
//      flips on receipt of `branch_started`.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { T, F_HEAD, F_BODY, F_MONO, tokenize, type Scene } from './theme';
import {
  Flourish,
  CornerOrn,
  MicIcon,
  Waveform,
} from './ornaments';

// Narration reveal pacing. The agent's TTS plays at roughly the same
// chars/sec the orchestrator uses to estimate segment duration (~17 cps +
// a short tail). We reveal text to land in step with that audio rather than
// at a fixed words-per-second, so the last word appears about when the
// narrator finishes speaking the scene — not seconds early. Mirrors the
// orchestrator's Scene→Segment duration heuristic in lib/orchestrator/index.ts.
const CHARS_PER_SEC = 17;
const TAIL_MS = 150;
const MIN_SCENE_MS = 700;

function estimateSceneAudioMs(text: string): number {
  return Math.max(MIN_SCENE_MS, Math.round((text.length / CHARS_PER_SEC) * 1000)) + TAIL_MS;
}

interface QaEntry {
  /** User's spoken question (best-effort from RTM transcript). */
  q: string;
  /** Agent's spoken answer (best-effort from RTM transcript). */
  a: string;
}

interface StoryScreenProps {
  scenes: Scene[];
  /** Index of the scene the agent is currently narrating. Parent advances
   *  this on `segment_completed`. */
  activeSceneIndex: number;
  /** Visual pause from a real BRANCH (server-driven via branch_started /
   *  branch_ended). When true, word reveal halts and the QA composer is
   *  visible. */
  inBranch: boolean;
  /** True once narration_complete fired — we hold on the last spread as the
   *  story's closing page (no mic, no "now reading" status). */
  finished: boolean;
  /** Per-scene QA history accumulated by the parent from the RTM transcript
   *  stream. Marginalia at the bottom of the right page. */
  qaHistoryByScene: Record<number, QaEntry[]>;
  /** True if the browser refused mic access — footer shows a retry hint. */
  micDenied: boolean;
  /** True if the user has the mic muted right now. The mic button toggles
   *  this. */
  micMuted: boolean;
  /** Toggle the AgoraRTC local mic enabled/disabled. The orchestrator's
   *  Agora VAD does the actual barge-in detection — the toggle is purely the
   *  user's wish to be heard. */
  onToggleMic: () => void;
  /** Hop back to the start screen. Tears down the session (parent abort). */
  onExit: () => void;
}

interface SceneStripProps {
  count: number;
  current: number;
  ready: number;
}

function SceneStrip({ count, current, ready }: SceneStripProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          aria-label={`scene-${i + 1}-${
            i < current ? 'done' : i === current ? 'current' : 'pending'
          }`}
          style={{
            width: 22,
            height: 6,
            background:
              i < current
                ? T.sage
                : i === current
                  ? T.rose
                  : i < ready
                    ? T.paperEdge
                    : T.paperEdge,
            opacity: i < ready ? 1 : 0.55,
            transition: 'background 0.2s, opacity 0.2s',
          }}
        />
      ))}
    </div>
  );
}

interface BookSpreadProps {
  scene: Scene;
  visibleCount: number;
  totalTokens: number;
  paused: boolean;
  qaHistory: QaEntry[];
}

function BookSpread({
  scene,
  visibleCount,
  totalTokens,
  paused,
  qaHistory,
}: BookSpreadProps) {
  // If the clip fails to load/decode, fall back to the still illustration
  // rather than showing a black box. Reset implicitly: BookSpread remounts
  // per scene (keyed wrapper in StoryScreen), so this starts false each page.
  const [videoFailed, setVideoFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // The clip's first frame is a BLANK page (it draws the art on from nothing).
  // `autoPlay` covers the happy path, but a browser that defers muted autoplay
  // (background/inactive tab, low-power mode, stricter policy) leaves the video
  // parked on that blank frame with no `error` event — so the plate would show
  // a blank box forever. Drive play() ourselves and, if it's rejected, fall
  // back to the still illustration (which is always the finished art). The
  // happy path is unchanged: play() resolves and the draw-on animation runs.
  useEffect(() => {
    if (!scene.video_url) return;
    const v = videoRef.current;
    if (!v) return;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => setVideoFailed(true));
    }
  }, [scene.video_url]);

  const tokens = useMemo(() => tokenize(scene.narration_text), [scene]);
  const visible = tokens.slice(0, visibleCount).join('');
  const remaining = tokens.slice(visibleCount).join('');

  return (
    <div
      style={{
        position: 'absolute',
        top: 60,
        left: 50,
        right: 50,
        bottom: 130,
        display: 'grid',
        gridTemplateColumns: '1.05fr 1px 1fr',
        background: T.paperHi,
        border: `1px solid ${T.paperEdge}`,
        boxShadow:
          '0 14px 40px rgba(60,40,20,0.10), 0 2px 0 rgba(60,40,20,0.04)',
      }}
    >
      {/* chapter ribbon */}
      <div
        style={{
          position: 'absolute',
          top: -14,
          left: '50%',
          transform: 'translateX(-50%)',
          background: T.paper,
          padding: '4px 22px',
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 14,
          color: T.inkSoft,
          letterSpacing: '0.15em',
          border: `1px solid ${T.paperEdge}`,
          borderRadius: 999,
        }}
      >
        {scene.chapter}
      </div>

      {/* LEFT — illustration (server-provided image_url) */}
      <div
        style={{
          padding: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: '100%',
            aspectRatio: '1 / 1',
            maxHeight: 460,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: scene.image_url ? 'transparent' : T.paper,
            border: scene.image_url ? 'none' : `1px dashed ${T.paperEdge}`,
            overflow: 'hidden',
          }}
        >
          {scene.video_url && !videoFailed ? (
            // Animated clip (parent Remotion render). Plays once then holds on
            // the last frame — we deliberately do NOT loop, since the clip
            // opens by drawing pencil strokes from blank and a loop would
            // "un-draw" the finished art. The subtle CSS breathe keeps the
            // held frame feeling alive while the narrator keeps reading. The
            // poster shows the still illustration until the first frame paints,
            // so the swap from <img> is seamless. On load/decode failure we
            // fall back to the still illustration below.
            <video
              key={scene.video_url}
              ref={videoRef}
              src={scene.video_url}
              onError={() => setVideoFailed(true)}
              poster={scene.image_url}
              autoPlay
              muted
              playsInline
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                animation:
                  'imgFade 0.6s ease both, breathe 7s ease-in-out 0.6s infinite',
              }}
            />
          ) : scene.image_url ? (
            // Still illustration — shown until its clip streams in (or as the
            // permanent fallback if the render failed).
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={scene.image_url}
              alt={`Illustration for ${scene.chapter}: ${scene.headline.join(' ')}`}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                animation:
                  'imgFade 0.6s ease both, breathe 7s ease-in-out 0.6s infinite',
              }}
            />
          ) : (
            <div
              style={{
                fontFamily: F_HEAD,
                fontStyle: 'italic',
                color: T.inkWhisper,
                fontSize: 14,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              · sketching …
            </div>
          )}
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 12,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontSize: 13,
            color: T.inkWhisper,
            letterSpacing: '0.06em',
          }}
        >
          — plate {scene.sceneNum.toLowerCase()} —
        </div>
        <style>{`@keyframes imgFade { from { opacity: 0; } to { opacity: 1; } } @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.012); } }`}</style>
      </div>

      {/* spine */}
      <div
        style={{
          background: `linear-gradient(180deg, transparent, ${T.paperEdge} 20%, ${T.paperEdge} 80%, transparent)`,
        }}
      />

      {/* RIGHT — text */}
      <div
        style={{
          padding: '48px 50px 32px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: '0.25em',
            color: T.rose,
            textTransform: 'uppercase',
            fontFamily: F_MONO,
          }}
        >
          {scene.sceneNum}
        </div>
        <h3
          style={{
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontWeight: 500,
            fontSize: 38,
            margin: '12px 0 14px',
            lineHeight: 1.1,
            letterSpacing: '-0.01em',
          }}
        >
          {scene.headline[0]}
          <br />
          {scene.headline[1]}
        </h3>
        <Flourish size={48} />

        <div
          style={{
            marginTop: 18,
            fontFamily: F_HEAD,
            fontSize: 19,
            lineHeight: 1.65,
            color: T.ink,
            minHeight: 160,
            flex: 1,
          }}
        >
          {visible}
          {!paused && visibleCount < totalTokens && (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: 19,
                background: T.rose,
                verticalAlign: -3,
                marginLeft: 1,
                animation: 'blink 0.9s infinite',
              }}
            />
          )}
          <span style={{ color: 'transparent' }}>{remaining}</span>
        </div>

        {qaHistory.length > 0 && (
          <div
            style={{
              marginTop: 18,
              paddingTop: 16,
              borderTop: `1px dashed ${T.paperEdge}`,
            }}
          >
            {qaHistory.map((qa, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div
                  style={{
                    fontFamily: F_MONO,
                    fontSize: 10,
                    letterSpacing: '0.25em',
                    color: T.rose,
                    marginBottom: 3,
                  }}
                >
                  YOU ASKED
                </div>
                <div
                  style={{
                    fontFamily: F_HEAD,
                    fontStyle: 'italic',
                    fontSize: 16,
                    color: T.inkSoft,
                    lineHeight: 1.5,
                  }}
                >
                  &ldquo;{qa.q}&rdquo;
                </div>
                {qa.a && (
                  <>
                    <div
                      style={{
                        fontFamily: F_MONO,
                        fontSize: 10,
                        letterSpacing: '0.25em',
                        color: T.sage,
                        margin: '8px 0 3px',
                      }}
                    >
                      TEACHER · no.{i + 1}
                    </div>
                    <div
                      style={{
                        fontFamily: F_HEAD,
                        fontSize: 16,
                        lineHeight: 1.55,
                        color: T.ink,
                      }}
                    >
                      {qa.a}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }`}</style>
    </div>
  );
}

interface BranchOverlayProps {
  qaHistory: QaEntry[];
}

function BranchOverlay({ qaHistory }: BranchOverlayProps) {
  // Last entry — the "live" exchange being captured.
  const last = qaHistory.length > 0 ? qaHistory[qaHistory.length - 1] : null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 116,
        left: 50,
        right: 50,
        background: T.paperHi,
        border: `1px solid ${T.rose}`,
        padding: '16px 22px',
        boxShadow:
          '0 -2px 0 rgba(199,123,106,0.1), 0 12px 30px rgba(60,40,20,0.10)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Waveform active={true} />
          <div
            style={{
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              fontSize: 15,
              color: T.rose,
              letterSpacing: '0.05em',
            }}
          >
            · Listening — go ahead, ask anything ·
          </div>
        </div>
        <div
          style={{
            fontFamily: F_MONO,
            fontSize: 10,
            color: T.inkSoft,
            letterSpacing: '0.2em',
          }}
        >
          BRANCH
        </div>
      </div>

      {last && (
        <div>
          {last.q && (
            <>
              <div
                style={{
                  fontFamily: F_MONO,
                  fontSize: 10,
                  letterSpacing: '0.25em',
                  color: T.rose,
                  marginBottom: 4,
                }}
              >
                YOU
              </div>
              <div
                style={{
                  fontFamily: F_HEAD,
                  fontStyle: 'italic',
                  fontSize: 16,
                  color: T.inkSoft,
                  marginBottom: 12,
                }}
              >
                &ldquo;{last.q}&rdquo;
              </div>
            </>
          )}
          {last.a && (
            <>
              <div
                style={{
                  fontFamily: F_MONO,
                  fontSize: 10,
                  letterSpacing: '0.25em',
                  color: T.sage,
                  marginBottom: 4,
                }}
              >
                THE TEACHER
              </div>
              <div
                style={{
                  fontFamily: F_HEAD,
                  fontSize: 17,
                  lineHeight: 1.6,
                  color: T.ink,
                }}
              >
                {last.a}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface StoryFooterProps {
  sceneIndex: number;
  sceneCount: number;
  readyCount: number;
  inBranch: boolean;
  finished: boolean;
  micMuted: boolean;
  micDenied: boolean;
  onToggleMic: () => void;
}

function StoryFooter({
  sceneIndex,
  sceneCount,
  readyCount,
  inBranch,
  finished,
  micMuted,
  micDenied,
  onToggleMic,
}: StoryFooterProps) {
  const iconBtn: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: `1px solid ${T.paperEdge}`,
    background: T.paperHi,
    cursor: 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.4,
  };

  // The mic glow swaps colour when we're actively in BRANCH so the user
  // sees the system is listening server-side. Local mic mute also shifts
  // the colour to muted-gray.
  const micActive = inBranch;
  const micBg = micMuted ? T.inkSoft : micActive ? T.rose : T.ink;
  const micGlow = micActive
    ? '0 0 0 6px rgba(199,123,106,0.18), 0 0 0 14px rgba(199,123,106,0.08)'
    : '0 4px 12px rgba(60,40,20,0.18)';

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 110,
        borderTop: `1px solid ${T.paperEdge}`,
        background: T.paper,
        padding: '0 50px',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SceneStrip
          count={sceneCount}
          current={sceneIndex}
          ready={readyCount}
        />
        <div
          style={{
            fontFamily: F_MONO,
            fontSize: 11,
            letterSpacing: '0.18em',
            color: T.inkSoft,
          }}
        >
          PAGE {String(sceneIndex + 1).padStart(2, '0')} · OF ·{' '}
          {String(sceneCount).padStart(2, '0')}
        </div>
      </div>

      {finished ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Flourish size={56} />
        </div>
      ) : (
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Prev / next disabled — narrator drives advance. We render them
            for visual parity but don't wire them; the agent decides when to
            turn the page. */}
        <button type="button" style={iconBtn} disabled aria-label="previous">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M 9 2 L 4 7 L 9 12"
              stroke={T.ink}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
          <button
            type="button"
            onClick={onToggleMic}
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: micBg,
              color: T.paper,
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: micGlow,
              position: 'relative',
              transition: 'all 0.2s',
            }}
            aria-label={micMuted ? 'tap to talk' : 'tap to stop'}
          >
            <MicIcon color={T.paper} size={22} />
            {micMuted && (
              <svg
                aria-hidden
                width="48"
                height="48"
                viewBox="0 0 48 48"
                style={{
                  position: 'absolute',
                  inset: 8,
                  pointerEvents: 'none',
                }}
              >
                <line
                  x1="6"
                  y1="42"
                  x2="42"
                  y2="6"
                  stroke={T.paper}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
          {/* Push-to-talk hint pinned under the mic so it never gets lost. */}
          <div
            style={{
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              fontSize: 12,
              color: micDenied ? T.rose : micMuted ? T.inkSoft : T.rose,
              letterSpacing: '0.05em',
              minHeight: 16,
              transition: 'color 0.2s',
            }}
          >
            {micDenied
              ? 'mic blocked — tap to retry'
              : inBranch
                ? 'listening…'
                : micMuted
                  ? 'tap to talk'
                  : 'tap to mute'}
          </div>
        </div>

        <button type="button" style={iconBtn} disabled aria-label="next">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M 5 2 L 10 7 L 5 12"
              stroke={T.ink}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      )}

      <div
        style={{
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 14,
          color: T.inkSoft,
          textAlign: 'right',
        }}
      >
        {finished
          ? 'The end · ← back to start'
          : micDenied
            ? 'Microphone blocked · allow it in your browser, then tap again'
            : inBranch
              ? 'Paused for question · I am listening'
              : micMuted
                ? 'Mic muted · click to speak'
                : 'Speak any time · I will stop and listen'}
      </div>
    </div>
  );
}

export function StoryScreen({
  scenes,
  activeSceneIndex,
  inBranch,
  finished,
  qaHistoryByScene,
  micMuted,
  micDenied,
  onToggleMic,
  onExit,
}: StoryScreenProps) {
  const safeIndex = Math.max(0, Math.min(scenes.length - 1, activeSceneIndex));
  const scene = scenes[safeIndex];

  // Word reveal. We tick visibleCount at WPS until we hit the scene's token
  // count. When activeSceneIndex changes we need to sweep from word 0 —
  // implemented via React 19's "reset state during render" pattern: comparing
  // a tracked scene id against the previous render's id and calling the
  // matching setter synchronously. This avoids an effect-driven cascade and
  // keeps the reveal frame-accurate across scene flips.
  const [visibleCount, setVisibleCount] = useState(0);
  const [trackedSceneId, setTrackedSceneId] = useState<string | null>(
    scene?.id ?? null,
  );
  if (scene && scene.id !== trackedSceneId) {
    setTrackedSceneId(scene.id);
    setVisibleCount(0);
  }

  const tokens = useMemo(
    () => (scene ? tokenize(scene.narration_text) : []),
    [scene],
  );
  const totalTokens = tokens.length;

  useEffect(() => {
    // Halt reveal during a BRANCH (Q&A) or once the scene is fully revealed.
    if (inBranch) return;
    if (visibleCount >= totalTokens || totalTokens === 0) return;
    // Spread the reveal of all tokens across the scene's estimated audio
    // duration so the cursor tracks the narrator's voice instead of racing
    // ahead. Floor the per-tick interval so a very short scene still animates.
    const audioMs = estimateSceneAudioMs(scene.narration_text);
    const intervalMs = Math.max(40, Math.round(audioMs / totalTokens));
    const id = setInterval(() => {
      setVisibleCount((v) => Math.min(totalTokens, v + 1));
    }, intervalMs);
    return () => clearInterval(id);
  }, [inBranch, visibleCount, totalTokens, scene]);

  const readyCount = useMemo(
    () => scenes.filter((s) => s.image_url).length,
    [scenes],
  );

  const handleExit = useCallback(() => onExit(), [onExit]);

  if (!scene) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: T.paper,
          color: T.ink,
          fontFamily: F_BODY,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            color: T.inkSoft,
          }}
        >
          (no scenes — please try again)
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: T.paper,
        color: T.ink,
        fontFamily: F_BODY,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: T.paperTexture,
          pointerEvents: 'none',
        }}
      />
      <CornerOrn pos="tl" inset={20} />
      <CornerOrn pos="tr" inset={20} />
      <CornerOrn pos="bl" inset={20} />
      <CornerOrn pos="br" inset={20} />

      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          top: 22,
          left: 50,
          right: 50,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontFamily: F_MONO,
          fontSize: 11,
          letterSpacing: '0.22em',
          color: T.inkSoft,
        }}
      >
        <button
          type="button"
          onClick={handleExit}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontSize: 14,
            color: T.inkSoft,
            padding: 0,
          }}
        >
          ← back to start
        </button>
        <div
          style={{
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            color: T.ink,
            fontSize: 15,
            letterSpacing: 0,
          }}
        >
          Tonight&apos;s Lesson
        </div>
        <div>
          {finished
            ? '· the end ·'
            : inBranch
              ? '· paused for question ·'
              : '· now reading ·'}
        </div>
      </div>

      {/* Book spread — keyed on scene id so the page truly remounts on
          advance (fresh fade-in animation on the illustration <img>). */}
      <div key={scene.id}>
        <BookSpread
          scene={scene}
          visibleCount={visibleCount}
          totalTokens={totalTokens}
          paused={inBranch}
          qaHistory={qaHistoryByScene[safeIndex] ?? []}
        />
      </div>

      {inBranch && (
        <BranchOverlay qaHistory={qaHistoryByScene[safeIndex] ?? []} />
      )}

      <StoryFooter
        sceneIndex={safeIndex}
        sceneCount={scenes.length}
        readyCount={readyCount}
        inBranch={inBranch}
        finished={finished}
        micMuted={micMuted}
        micDenied={micDenied}
        onToggleMic={onToggleMic}
      />
    </div>
  );
}

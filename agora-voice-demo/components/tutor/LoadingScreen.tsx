// Loading stage — visual port of prototype-screens.jsx:112-242 but driven by
// real SSE progress instead of fake timers.
//
// Step → SSE mapping (per spec):
//   Step 0 "Reading your material"      done on `script_drafted`
//   Step 1 "Drafting the story script"  done on `scenes_composed`
//   Step 2 "Composing the scenes"       fractional progress = imagesReady / totalScenes
//   Step 3 "Sketching each illustration"done on `all_images_ready`
//
// `session_started` is what flips the parent from loading → story; we don't
// observe it here, but we do drive the overall progress bar from the same
// 0..1 scalar the prototype used (step + intra-step / 4).

'use client';

import { useMemo } from 'react';
import { T, F_HEAD, F_BODY, F_MONO } from './theme';
import { Flourish, CornerOrn } from './ornaments';

export interface LoadingState {
  /** True once `script_drafted` has been observed. */
  scriptDrafted: boolean;
  /** True once `scenes_composed` has been observed. */
  scenesComposed: boolean;
  /** Number of `image_ready` events observed so far. */
  imagesReady: number;
  /** Total scene count from `scenes_composed`. 0 until we know. */
  totalScenes: number;
  /** True once `all_images_ready` has fired. */
  allImagesReady: boolean;
  /** Number of `video_ready` events observed so far. The loading screen only
   *  lives until scene 1's video is ready (session_started then flips us to
   *  the story), so in practice this drives the final "bringing to life" step
   *  from 0 → 1. */
  videosReady: number;
}

const STEP_NAMES = [
  { label: 'Reading your material', sub: 'Skimming for the good parts' },
  { label: 'Drafting the story script', sub: 'Picking the through-line' },
  { label: 'Composing the scenes', sub: 'Breaking it into pages' },
  {
    label: 'Sketching each illustration',
    sub: 'Page-by-page, in ink and wash',
  },
  {
    label: 'Bringing them to life',
    sub: 'Painting each page into motion',
  },
] as const;

interface StepView {
  index: number;
  label: string;
  sub: string;
  status: 'pending' | 'active' | 'done';
  /** 0..1 within an active step (for the global progress bar). */
  intraProgress: number;
}

function deriveSteps(s: LoadingState): StepView[] {
  // Step 0 is always at least active from the start (we begin "reading"
  // the moment the SSE stream opens).
  const out: StepView[] = STEP_NAMES.map((step, i) => ({
    index: i,
    label: step.label,
    sub: step.sub,
    status: 'pending',
    intraProgress: 0,
  }));

  // Step 0 — reading. We have no granular signal, so it's active from start
  // and flips done on script_drafted.
  out[0].status = s.scriptDrafted ? 'done' : 'active';
  out[0].intraProgress = s.scriptDrafted ? 1 : 0.4;
  if (!s.scriptDrafted) return out;

  // Step 1 — drafting. Active until scenes_composed.
  out[1].status = s.scenesComposed ? 'done' : 'active';
  out[1].intraProgress = s.scenesComposed ? 1 : 0.5;
  if (!s.scenesComposed) return out;

  // Step 2 — composing (scenes_composed fires instantly, so this is
  // effectively done the moment we receive the scene list).
  out[2].status = 'done';
  out[2].intraProgress = 1;

  // Step 3 — sketching. Tracks per-image readiness.
  const fraction =
    s.totalScenes > 0 ? Math.min(1, s.imagesReady / s.totalScenes) : 0;
  if (s.allImagesReady) {
    out[3].status = 'done';
    out[3].intraProgress = 1;
  } else {
    out[3].status = 'active';
    out[3].intraProgress = fraction;
    return out;
  }

  // Step 4 — animating. Scene 1's clip renders (~8s) between all_images_ready
  // and session_started; this step fills that window so the bar doesn't sit at
  // a frozen 100%. Done the moment the first video lands (we then cut to the
  // story almost immediately).
  if (s.videosReady >= 1) {
    out[4].status = 'done';
    out[4].intraProgress = 1;
  } else {
    out[4].status = 'active';
    out[4].intraProgress = 0.4;
  }

  return out;
}

interface LoadingScreenProps {
  state: LoadingState;
}

export function LoadingScreen({ state }: LoadingScreenProps) {
  const steps = useMemo(() => deriveSteps(state), [state]);

  // Overall progress: average of step contributions to the 4-step bar.
  const progress = useMemo(() => {
    const sum = steps.reduce((acc, s) => {
      if (s.status === 'done') return acc + 1;
      if (s.status === 'active') return acc + s.intraProgress;
      return acc;
    }, 0);
    return sum / STEP_NAMES.length;
  }, [steps]);

  const allDone = state.videosReady >= 1;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: T.paper,
        color: T.ink,
        fontFamily: F_BODY,
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
      <CornerOrn pos="tl" />
      <CornerOrn pos="tr" />
      <CornerOrn pos="bl" />
      <CornerOrn pos="br" />

      <div
        style={{
          position: 'absolute',
          top: '15%',
          left: 0,
          right: 0,
          textAlign: 'center',
        }}
      >
        <Flourish size={70} />
        <h2
          style={{
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontWeight: 500,
            fontSize: 44,
            margin: '20px 0 8px',
          }}
        >
          Preparing tonight&apos;s lesson
        </h2>
        <p
          style={{
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            color: T.inkSoft,
            fontSize: 16,
            margin: 0,
          }}
        >
          Just a moment while I draft your story —
        </p>
      </div>

      <div
        style={{
          position: 'absolute',
          top: '38%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(640px, 80vw)',
          background: T.paperHi,
          border: `1px solid ${T.paperEdge}`,
          borderRadius: 4,
          padding: '32px 40px',
          boxShadow: '0 12px 30px rgba(60,40,20,0.06)',
        }}
      >
        {steps.map((s, i) => {
          const done = s.status === 'done';
          const active = s.status === 'active';
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                padding: '14px 0',
                borderBottom:
                  i < STEP_NAMES.length - 1
                    ? `1px solid ${T.paperEdge}`
                    : 'none',
                transition: 'opacity 0.3s',
                opacity: done || active ? 1 : 0.55,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: `1.5px solid ${
                    done ? T.sage : active ? T.rose : T.paperEdge
                  }`,
                  background: done ? T.sage : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all 0.3s',
                }}
              >
                {done && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M 3 7 L 6 10 L 11 4"
                      stroke={T.paper}
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                {active && (
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: T.rose,
                      animation: 'pulse 1.2s ease-in-out infinite',
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: F_HEAD,
                    fontSize: 20,
                    fontStyle: active ? 'italic' : 'normal',
                    color: done || active ? T.ink : T.inkSoft,
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: T.inkSoft,
                    fontStyle: 'italic',
                    marginTop: 2,
                    letterSpacing: '0.06em',
                  }}
                >
                  {s.sub}
                </div>
              </div>
              {active && (
                <div
                  style={{
                    fontSize: 13,
                    color: T.rose,
                    fontStyle: 'italic',
                    fontFamily: F_HEAD,
                  }}
                >
                  {s.index === 3 && state.totalScenes > 0
                    ? `${state.imagesReady}/${state.totalScenes} …`
                    : s.index === 4
                      ? 'rendering …'
                      : 'in progress …'}
                </div>
              )}
              {done && (
                <div
                  style={{
                    fontSize: 12,
                    color: T.sage,
                    fontFamily: F_MONO,
                    letterSpacing: '0.15em',
                  }}
                >
                  ✓ DONE
                </div>
              )}
            </div>
          );
        })}

        {/* progress bar */}
        <div
          style={{
            marginTop: 24,
            height: 3,
            background: T.paperEdge,
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress * 100}%`,
              height: '100%',
              background: T.rose,
              transition: 'width 0.2s linear',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: T.inkSoft,
            fontFamily: F_MONO,
            letterSpacing: '0.15em',
            textAlign: 'center',
          }}
        >
          {allDone
            ? 'READY · turning the page'
            : `${Math.round(progress * 100)}% · about a moment more`}
        </div>
      </div>

      <style>{`@keyframes pulse {0%,100%{transform:scale(1);opacity:1}50%{transform:scale(0.7);opacity:0.5}}`}</style>
    </div>
  );
}

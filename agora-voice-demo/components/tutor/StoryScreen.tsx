// Story screen — two-pane conversation feed. A faithful implementation of the
// finalized design (reference/storybook-prototype/prototype-story.jsx): a left
// framed "stage" showing the current scene's illustration with a Ken-Burns
// float, and a right scrolling conversation feed where the narration arrives as
// the teacher's chat bubbles, interleaved with the user's spoken questions and
// the teacher's answers.
//
// Crucially, this is wired to REAL data — NOT the prototype's canned SCENES/
// QA_BANK + simulated transcript. Differences from the mockup's simulation:
//
//   1. Scenes, narration, and Q&A come from props (the SSE pipeline + the live
//      RTM transcript). We render the FULL narration_text for each scene — the
//      streaming cursor is decorative (audio-synced page tracking, not a
//      word-reveal timer).
//   2. The "current scene" is inferred from the live agent transcript via
//      matchSceneIndex, kept monotonic with a high-water mark (preserved from
//      the prior StoryScreen) so the page can't flip ahead of (or behind) the
//      voice.
//   3. The illustration is the real asset: <video> (Remotion clip) with an
//      image fallback, else <img>, else a "sketching" placeholder.
//   4. The composer is voice-first and wired to the REAL mic. Real barge-in is
//      driven by Agora's server-side VAD + the silence timer — there is no
//      manual submit path. The "send"/"continue" affordances are kept visually
//      but do not invent a submit (see the TODO comments).

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { T, F_HEAD, F_BODY, F_MONO, tokenize, type Scene } from './theme';
import { matchSceneIndex, revealedTokenCount } from './reveal-sync';
import { MicIcon, PlayIcon } from './ornaments';
import { clamp } from '@/lib/utils';

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
   *  branch_ended). When true, the composer reflects the listening/thinking
   *  state and the stage chip shows "paused for you". */
  inBranch: boolean;
  /** True once narration_complete fired — we hold on the last scene as the
   *  story's closing page (no "continue" affordance). */
  finished: boolean;
  /** Agora's live agent transcript — what the voice is actually saying right
   *  now, grown word-by-word as the TTS plays. When it aligns with a scene's
   *  narration, the feed's "current page" tracks it (audio-synced). Null before
   *  any agent transcript has arrived. */
  liveNarrationText: string | null;
  /** Agora's live USER transcript — the in-progress question echoed in the
   *  voice composer while listening. Null before any user transcript. */
  liveUserText: string | null;
  /** Per-scene QA history accumulated by the parent from the RTM transcript
   *  stream. Interleaved into the feed after each scene's teacher bubble. */
  qaHistoryByScene: Record<number, QaEntry[]>;
  /** True if the browser refused mic access — composer shows a retry hint. */
  micDenied: boolean;
  /** True if the user has the mic muted right now. */
  micMuted: boolean;
  /** Live mic amplitude 0..1 (parent polls the AgoraRTC track). Scales the
   *  waveform so the user can SEE they're being heard. 0 when muted/absent. */
  micLevel: number;
  /** The agent's live conversational state ('idle' | 'speaking' | 'listening'
   *  | 'thinking' | 'silent' …) from Agora ConvoAI. Drives the derived phase. */
  agentState: string;
  /** Toggle the AgoraRTC local mic enabled/disabled. The orchestrator's Agora
   *  VAD does the actual barge-in detection — the toggle is the user's wish to
   *  be heard. */
  onToggleMic: () => void;
  /** Submit a typed question — interrupts + sends to the agent (text-mode QA). */
  onTextQuestion: (text: string) => void;
  /** Hop back to the start screen. Tears down the session (parent abort). */
  onExit: () => void;
}

type Phase = 'reading' | 'paused' | 'listening' | 'thinking';

// ──────────────────────────────────────────────────────────────
// Composer waveform — bars react to mic amplitude when active. Mirrors the
// prototype's 7-bar rose waveform.
function Waveform({ active, level = 0 }: { active: boolean; level?: number }) {
  // Resting scale 0.25; bloom toward 1 with amplitude. The per-bar keyframe
  // animation supplies the lively motion; level lifts the baseline so a louder
  // voice visibly pushes the bars taller.
  const floor = active ? 0.25 + clamp(level, 0, 1) * 0.55 : 0.25;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 18 }}>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: '100%',
            background: T.rose,
            borderRadius: 2,
            opacity: 0.85,
            animation: active
              ? `wave ${0.6 + (i % 3) * 0.15}s ease-in-out ${i * 0.08}s infinite`
              : 'none',
            transformOrigin: 'center',
            transform: `scaleY(${floor})`,
          }}
        />
      ))}
      <style>{`@keyframes wave { 0%,100% { transform: scaleY(0.25);} 50% { transform: scaleY(1);} }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// LEFT — illustration stage (framed like a video)
interface StageFrameProps {
  scene: Scene;
  sceneIndex: number;
  sceneCount: number;
  phase: Phase;
}

function StageFrame({ scene, sceneIndex, sceneCount, phase }: StageFrameProps) {
  const paused = phase === 'paused';
  const busy = phase === 'thinking';

  // If the clip fails to load/decode, fall back to the still illustration
  // rather than showing a black box. Track WHICH clip url failed (not a bare
  // boolean) so the fallback auto-resets when a new scene's clip swaps in.
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const videoFailed = !!scene.video_url && failedVideoUrl === scene.video_url;
  const videoRef = useRef<HTMLVideoElement>(null);

  // A browser that defers muted autoplay leaves the video parked on its blank
  // first frame with no `error` event — drive play() ourselves and fall back to
  // the still illustration if it's rejected.
  useEffect(() => {
    const url = scene.video_url;
    if (!url) return;
    const v = videoRef.current;
    if (!v) return;
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => setFailedVideoUrl(url));
    }
  }, [scene.video_url]);

  const dotColor = busy ? T.rose : paused ? T.inkWhisper : T.sage;
  const chipLabel = busy ? 'paused for you' : paused ? 'paused' : 'narrating';
  const plate = ['i', 'ii', 'iii', 'iv', 'v', 'vi'][sceneIndex] || 'i';

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '0 30px 0 0',
      }}
    >
      {/* the "screen" */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          background: T.paperHi,
          border: `1px solid ${T.paperEdge}`,
          borderRadius: 6,
          overflow: 'hidden',
          boxShadow: '0 14px 40px rgba(60,40,20,0.10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* soft wash bg */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: T.paperTexture,
            pointerEvents: 'none',
          }}
        />

        {/* scene label, top-left */}
        <div
          style={{
            position: 'absolute',
            top: 16,
            left: 18,
            zIndex: 2,
            fontFamily: F_MONO,
            fontSize: 10,
            letterSpacing: '0.22em',
            color: T.inkSoft,
          }}
        >
          {/* No "Chapter X" label — keep a neutral plate marker so the stage
              reads like a video frame, not a storybook chapter. */}
          PLATE {plate.toUpperCase()}
        </div>

        {/* playing/paused chip top-right */}
        <div
          style={{
            position: 'absolute',
            top: 14,
            right: 16,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontSize: 12,
            color: T.inkSoft,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: dotColor,
              animation: !paused && !busy ? 'breathe 1.6s ease-in-out infinite' : 'none',
            }}
          />
          {chipLabel}
        </div>

        {/* illustration with gentle float (Ken-Burns-lite). The real asset —
            video clip, still image, or a sketching placeholder. */}
        <div
          key={scene.id}
          style={{
            width: '82%',
            aspectRatio: '1 / 1',
            maxHeight: '78%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            animation: 'floatStage 9s ease-in-out infinite',
          }}
        >
          {scene.video_url && !videoFailed ? (
            <video
              key={scene.video_url}
              ref={videoRef}
              src={scene.video_url}
              onError={() => setFailedVideoUrl(scene.video_url ?? null)}
              poster={scene.image_url}
              autoPlay
              muted
              loop
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : scene.image_url ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={scene.image_url}
              alt={`Illustration for ${scene.chapter}: ${scene.headline.join(' ')}`}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
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

        {/* caption */}
        <div
          style={{
            position: 'absolute',
            bottom: 14,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontFamily: F_HEAD,
            fontStyle: 'italic',
            fontSize: 13,
            color: T.inkWhisper,
            letterSpacing: '0.05em',
          }}
        >
          — plate {plate} —
        </div>
      </div>

      {/* under-stage — passive progress only (left side is auto-narrated). No
          transport buttons: the dots are a progress indicator, nothing more. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          marginTop: 14,
        }}
      >
        <div data-testid="scene-dots" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {Array.from({ length: sceneCount }).map((_, i) => (
            <div
              key={i}
              style={{
                width: i === sceneIndex ? 22 : 8,
                height: 8,
                background:
                  i < sceneIndex ? T.sage : i === sceneIndex ? T.rose : T.paperEdge,
                borderRadius: 999,
                transition: 'all 0.25s',
              }}
            />
          ))}
        </div>
        <div
          style={{
            fontFamily: F_MONO,
            fontSize: 10,
            letterSpacing: '0.18em',
            color: T.inkWhisper,
          }}
        >
          {String(sceneIndex + 1).padStart(2, '0')} /{' '}
          {String(sceneCount).padStart(2, '0')}
        </div>
      </div>

      <style>{`
        @keyframes floatStage { 0%,100%{transform:scale(1) translateY(0)} 50%{transform:scale(1.03) translateY(-4px)} }
        @keyframes breathe { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Message bubbles

interface TeacherBubbleProps {
  headline?: string;
  text: string;
  streaming?: boolean;
  isAnswer?: boolean;
}

function TeacherBubble({ headline, text, streaming, isAnswer }: TeacherBubbleProps) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      {/* avatar */}
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          flexShrink: 0,
          background: T.paper,
          border: `1px solid ${T.gold}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 17,
          color: T.gold,
          marginTop: 2,
        }}
      >
        T
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {headline && (
          <h3
            style={{
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              fontWeight: 500,
              fontSize: 23,
              margin: '0 0 8px',
              lineHeight: 1.15,
              color: T.ink,
            }}
          >
            {headline}
          </h3>
        )}
        <div
          style={{
            background: isAnswer ? 'rgba(196,154,75,0.08)' : T.paperHi,
            border: `1px solid ${T.paperEdge}`,
            borderRadius: '4px 16px 16px 16px',
            padding: '14px 18px',
            fontFamily: F_HEAD,
            fontSize: 18,
            lineHeight: 1.62,
            color: T.ink,
          }}
        >
          {isAnswer && (
            <div
              style={{
                fontFamily: F_MONO,
                fontSize: 9,
                letterSpacing: '0.25em',
                color: T.sage,
                marginBottom: 6,
              }}
            >
              IN ANSWER TO YOU
            </div>
          )}
          {text}
          {streaming && (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: 18,
                background: T.rose,
                verticalAlign: -3,
                marginLeft: 2,
                animation: 'blink 0.9s infinite',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function UserBubble({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '80%',
          background: T.ink,
          color: T.paper,
          borderRadius: '16px 4px 16px 16px',
          padding: '12px 18px',
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 17,
          lineHeight: 1.5,
          // Interim (still-being-spoken) transcript: slightly translucent with a
          // blinking caret, so it reads as "hearing you…" vs a committed turn.
          opacity: live ? 0.7 : 1,
        }}
      >
        {text}
        {live && (
          <span
            style={{
              display: 'inline-block',
              width: 2,
              height: 16,
              background: T.paper,
              verticalAlign: -2,
              marginLeft: 3,
              animation: 'blink 0.9s infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: '50%',
          flexShrink: 0,
          background: T.paper,
          border: `1px solid ${T.gold}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 17,
          color: T.gold,
        }}
      >
        T
      </div>
      <div
        style={{
          background: T.paperHi,
          border: `1px solid ${T.paperEdge}`,
          borderRadius: '4px 16px 16px 16px',
          padding: '14px 18px',
          display: 'flex',
          gap: 5,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: T.inkWhisper,
              animation: `bob 1s ease-in-out ${i * 0.15}s infinite`,
            }}
          />
        ))}
      </div>
      <style>{`@keyframes bob { 0%,100%{transform:translateY(0);opacity:0.4} 50%{transform:translateY(-5px);opacity:1} }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// RIGHT — conversation feed + composer
interface ConversationPanelProps {
  scenes: Scene[];
  currentIndex: number;
  phase: Phase;
  /** True while a Q&A branch is open — pauses the subtitle reveal so it can't
   *  creep ahead while the narration voice is stopped. */
  inBranch: boolean;
  /** Agora's live agent transcript — drives the current scene's subtitle reveal. */
  liveNarrationText: string | null;
  qaHistoryByScene: Record<number, QaEntry[]>;
  liveUserText: string | null;
  micLevel: number;
  micMuted: boolean;
  micDenied: boolean;
  finished: boolean;
  onToggleMic: () => void;
  /** Submit a typed question — interrupts the story (pause), sends it to the
   *  agent via the toolkit's sendText, and the answer flows back like a voice
   *  Q&A. The text-mode alternative to speaking. */
  onTextQuestion: (text: string) => void;
}

function ConversationPanel({
  scenes,
  currentIndex,
  phase,
  inBranch,
  liveNarrationText,
  qaHistoryByScene,
  liveUserText,
  micLevel,
  micMuted,
  micDenied,
  finished,
  onToggleMic,
  onTextQuestion,
}: ConversationPanelProps) {
  // Subtitle reveal for the scene being narrated (anti-spoiler) — only the words
  // spoken so far, synced to the live voice. ACTIVE whenever NOT in a Q&A branch
  // (i.e. during narration): narration say() registers as agent-state silent,
  // NOT speaking, so gating on "speaking" left the subtitle blank through whole
  // scenes (live-found 2026-06-01). Past scenes render in full.
  const currentRevealedText = useSubtitleReveal(
    scenes[currentIndex]?.narration_text ?? '',
    liveNarrationText,
    !inBranch && !finished,
  );
  // Voice-first by default; text mode is a real alternative path (onTextQuestion).
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentChapterRef = useRef<HTMLDivElement>(null);

  const listening = phase === 'listening';
  const thinking = phase === 'thinking';

  // NEW CHAPTER → bring its heading to the TOP of the feed (a "fresh page"
  // turn), so the chapter you're hearing reads from the top down and earlier
  // chapters sit above as history you scroll up to revisit — rather than the
  // feed jamming everything to the bottom.
  //
  // We scroll the feed by the element's `offsetTop` (its UNSCALED layout offset
  // within the feed) rather than scrollIntoView(): the whole stage is rendered
  // under a CSS `transform: scale()` (ScalingStage), and scrollIntoView/
  // getBoundingClientRect report SCALED pixels while scrollTop is in unscaled
  // content pixels — so scrollIntoView landed in the wrong place (the chapter
  // didn't actually go to the top). offsetTop is transform-immune. The feed is
  // position:relative (below) so offsetTop is measured relative to it.
  useEffect(() => {
    const feed = scrollRef.current;
    const el = currentChapterRef.current;
    if (!feed || !el) return;
    feed.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: 'smooth' });
  }, [currentIndex]);

  // WITHIN a chapter (a Q&A exchange or the live transcript growing) → keep the
  // latest line in view so the user sees their question + the answer. This does
  // NOT fire on chapter change (handled above), so it never fights the
  // fresh-page scroll, and it leaves the user free to scroll up through history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [qaHistoryByScene, liveUserText]);

  // Simple segmented toggle: left = voice (mic), right = keyboard. The active
  // side is filled; tap a side to switch. No "type instead / use voice" prose.
  const segBtn = (active: boolean) =>
    ({
      width: 34,
      height: 26,
      borderRadius: 999,
      border: 'none',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: active ? T.ink : 'transparent',
    }) as const;
  const modeToggle = (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        background: T.paperHi,
        border: `1px solid ${T.paperEdge}`,
        borderRadius: 999,
        padding: 2,
      }}
    >
      <button type="button" title="Voice" onClick={() => setInputMode('voice')} style={segBtn(inputMode === 'voice')}>
        <MicIcon color={inputMode === 'voice' ? T.paper : T.inkSoft} size={14} />
      </button>
      <button type="button" title="Keyboard" onClick={() => setInputMode('text')} style={segBtn(inputMode === 'text')}>
        <svg width="16" height="13" viewBox="0 0 16 13" fill="none">
          <rect x="1" y="1" width="14" height="11" rx="2" stroke={inputMode === 'text' ? T.paper : T.inkSoft} strokeWidth="1.2" />
          <path
            d="M 4 4.5 h 1 M 7 4.5 h 1 M 10 4.5 h 1 M 4 7 h 1 M 7 7 h 1 M 10 7 h 1 M 5.5 9.5 h 5"
            stroke={inputMode === 'text' ? T.paper : T.inkSoft}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: T.paper,
        borderLeft: `1px solid ${T.paperEdge}`,
        paddingLeft: 30,
      }}
    >
      {/* feed */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          // minHeight:0 is REQUIRED for a flex child to scroll instead of
          // growing to its content height. Without it the feed expanded past
          // the stage, pushing the composer off-screen with no way to scroll.
          minHeight: 0,
          // position:relative makes this the offsetParent for the chapter
          // dividers, so currentChapterRef.offsetTop is measured relative to the
          // feed content (used by the new-chapter snap-to-top scroll above).
          position: 'relative',
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: '4px 8px 18px 0',
        }}
      >
        {scenes.slice(0, currentIndex + 1).flatMap((scene, i) => {
          // Pure-chatbot feed: each narrated scene is just a teacher message —
          // no "Chapter X" divider, no headline. The CURRENT scene's bubble
          // carries the ref the auto-scroll pins to the top on scene change.
          const isCurrent = i === currentIndex;
          const narration = (
            <TeacherBubble
              // Current scene: subtitle reveal (only words spoken so far) so the
              // listener can't read the whole scene ahead of the voice. Past
              // scenes: full text (already spoken).
              text={isCurrent ? currentRevealedText : scene.narration_text}
              streaming={phase === 'reading' && isCurrent}
            />
          );
          const nodes = [
            i === currentIndex ? (
              <div key={`${scene.id}-narration`} ref={currentChapterRef} data-testid="narration-current">
                {narration}
              </div>
            ) : (
              <div key={`${scene.id}-narration`}>{narration}</div>
            ),
          ];
          // Interleave this scene's Q&A: user question, then the teacher's
          // gold-tinted answer (if any). Skip empties.
          const qas = qaHistoryByScene[i] ?? [];
          qas.forEach((qa, j) => {
            if (qa.q && qa.q.trim()) {
              nodes.push(<UserBubble key={`${scene.id}-q-${j}`} text={qa.q} />);
            }
            if (qa.a && qa.a.trim()) {
              nodes.push(
                <TeacherBubble key={`${scene.id}-a-${j}`} text={qa.a} isAnswer />,
              );
            }
          });
          return nodes;
        })}
        {/* LIVE interrupt — show the user's in-progress speech in real-time as a
            chat bubble the moment they start talking (before it's committed to
            qaHistory), so interrupting feels instant and you can SEE what STT is
            hearing — mirrors the `/` chat's in-progress message. */}
        {liveUserText && liveUserText.trim() && (
          <UserBubble text={liveUserText} live />
        )}
        {thinking && <ThinkingBubble />}
      </div>

      {/* continue-the-story affordance when paused mid-story. Cosmetic in the
          real app — resume is automatic after the silence timer. We only stop
          the live mic if it's on; otherwise it's a no-op. */}
      {phase === 'paused' && !finished && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '0 0 10px' }}>
          <button
            type="button"
            onClick={() => {
              // TODO: there is no explicit "resume" path — narration resumes on
              // its own after the silence timer. If the mic happens to be live
              // we mute it (stop listening); otherwise this is a no-op.
              if (!listening) return;
              onToggleMic();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: T.sage,
              color: T.paper,
              border: 'none',
              padding: '8px 18px',
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              fontSize: 15,
              cursor: 'pointer',
              borderRadius: 999,
              boxShadow: '0 4px 12px rgba(139,157,126,0.28)',
            }}
          >
            <PlayIcon color={T.paper} size={12} /> continue the story
          </button>
        </div>
      )}

      {/* composer — always docked */}
      <div style={{ paddingRight: 8, paddingBottom: 4 }}>
        {/* ===== VOICE MODE ===== */}
        {inputMode === 'voice' &&
          (listening ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: T.paperHi,
                border: `1px solid ${T.rose}`,
                borderRadius: 22,
                padding: '10px 10px 10px 18px',
                boxShadow: '0 0 0 4px rgba(199,123,106,0.12)',
              }}
            >
              {/* REC dot + waveform */}
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: T.rose,
                    animation: 'recBlink 1s ease-in-out infinite',
                  }}
                />
                <Waveform active level={micLevel} />
              </span>
              {/* live transcript — the user's in-progress question */}
              <div
                style={{
                  flex: 1,
                  fontFamily: F_HEAD,
                  fontStyle: 'italic',
                  fontSize: 17,
                  color: liveUserText ? T.ink : T.inkWhisper,
                  lineHeight: 1.4,
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}
              >
                {liveUserText || 'Listening…'}
              </div>
              {/* cancel — mute/stop the real mic */}
              <button
                type="button"
                onClick={onToggleMic}
                title="Cancel"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: 'transparent',
                  border: `1px solid ${T.paperEdge}`,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: F_HEAD,
                  fontSize: 16,
                  color: T.inkSoft,
                }}
              >
                ✕
              </button>
            </div>
          ) : micMuted ? (
            // Muted by the user — tap to go live again.
            <button
              type="button"
              onClick={onToggleMic}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                background: T.ink,
                color: T.paper,
                border: 'none',
                cursor: 'pointer',
                borderRadius: 22,
                padding: '15px 18px',
                fontFamily: F_HEAD,
                fontStyle: 'italic',
                fontSize: 18,
                letterSpacing: '0.01em',
                boxShadow: '0 6px 16px rgba(60,40,20,0.18)',
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  background: 'rgba(246,239,224,0.16)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <MicIcon color={T.paper} size={19} />
              </span>
              Muted — tap to talk
            </button>
          ) : (
            // ALWAYS-ON: the mic is live. The listener just speaks to interrupt
            // — no tap needed. This bar is a passive "I'm listening" affordance
            // with a mute control on the right.
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: T.paperHi,
                border: `1px solid ${T.paperEdge}`,
                borderRadius: 22,
                padding: '12px 12px 12px 18px',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: T.sage,
                  flexShrink: 0,
                  animation: 'breathe 1.8s ease-in-out infinite',
                }}
              />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: F_HEAD,
                  fontStyle: 'italic',
                  fontSize: 17,
                  color: T.inkSoft,
                }}
              >
                Listening — just speak to interrupt
              </div>
              <button
                type="button"
                onClick={onToggleMic}
                title="Mute"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  background: 'transparent',
                  border: `1px solid ${T.paperEdge}`,
                  borderRadius: 999,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontFamily: F_HEAD,
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: T.inkSoft,
                  flexShrink: 0,
                }}
              >
                <MicIcon color={T.inkSoft} size={14} /> mute
              </button>
            </div>
          ))}

        {/* ===== TEXT MODE — typed question interrupts + goes to the agent ===== */}
        {inputMode === 'text' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: T.paperHi,
              border: `1px solid ${listening ? T.rose : T.paperEdge}`,
              borderRadius: 999,
              padding: '7px 7px 7px 18px',
              transition: 'border-color 0.2s',
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim()) {
                  e.preventDefault();
                  onTextQuestion(draft.trim());
                  setDraft('');
                }
              }}
              placeholder="Type a question to interrupt — Enter to ask…"
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: T.ink,
                fontFamily: F_HEAD,
                fontStyle: 'italic',
                fontSize: 17,
                outline: 'none',
              }}
            />
            <button
              type="button"
              disabled={!draft.trim()}
              title="Ask"
              onClick={() => {
                if (!draft.trim()) return;
                onTextQuestion(draft.trim());
                setDraft('');
              }}
              style={{
                width: 42,
                height: 42,
                borderRadius: '50%',
                flexShrink: 0,
                background: draft.trim() ? T.ink : T.paperEdge,
                color: T.paper,
                border: 'none',
                cursor: draft.trim() ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path
                  d="M 3 9 L 15 9 M 10 4 L 15 9 L 10 14"
                  stroke={T.paper}
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        {/* hint + mode toggle */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 9,
            paddingLeft: 4,
          }}
        >
          <div
            style={{
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              fontSize: 12.5,
              color: T.inkWhisper,
            }}
          >
            {micDenied
              ? 'Microphone blocked · allow it in your browser to talk'
              : micMuted
                ? 'Muted · tap to talk, then just speak anytime'
                : phase === 'reading'
                  ? 'Mic is live · just speak anytime to interrupt'
                  : phase === 'paused'
                    ? 'Story paused · just speak, or it’ll continue on its own'
                    : phase === 'listening'
                      ? 'Listening · I’ll answer when you pause'
                      : 'The teacher is thinking…'}
          </div>
          {modeToggle}
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
        @keyframes recBlink { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes breathe { 0%,100%{opacity:1} 50%{opacity:0.35} }
      `}</style>
    </div>
  );
}

// Tokens revealed per floor-tick — a speech-paced fallback so the subtitle
// keeps flowing when the live transcript lags or misses, WITHOUT racing ahead
// of the voice (≈150 wpm ≈ 2.5 words/s ≈ 5 tokens/s ≈ 1 token / 200ms; tokenize
// keeps separators so a word ≈ 2 tokens → ~1 word / 400ms). Audio-sync
// (revealedTokenCount) overrides this UPWARD whenever the transcript aligns.
const REVEAL_TICK_MS = 200;

/**
 * SUBTITLE REVEAL for the scene currently being narrated: show only the words
 * spoken so far — audio-synced to Agora's live agent transcript, with a
 * speech-paced time floor (so text still appears if the transcript lags) and a
 * pause while `active` is false (a barge-in), so the reveal can NEVER run ahead
 * of the voice. This is the anti-spoiler fix: dumping the whole scene text at
 * once let the listener read instead of listen. Past scenes render in full
 * (already spoken) — the caller passes their text directly, not through here.
 */
function useSubtitleReveal(narration: string, spokenSoFar: string | null, active: boolean): string {
  const tokens = useMemo(() => tokenize(narration), [narration]);
  const [floor, setFloor] = useState<{ narration: string; count: number }>({
    narration,
    count: 0,
  });

  // Audio-synced count: jump to however many words Agora reports as spoken.
  const audioRevealed = useMemo(() => {
    if (!active) return;
    return revealedTokenCount(narration, spokenSoFar ?? '');
  }, [narration, spokenSoFar, active]);

  // Speech-paced floor — advances ONLY while actively narrating (so it pauses
  // during a barge-in and can't creep ahead while the voice is stopped).
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setFloor((prev) => {
        const count = prev.narration === narration ? prev.count : 0;
        return { narration, count: Math.min(tokens.length, count + 1) };
      });
    }, REVEAL_TICK_MS);
    return () => clearInterval(id);
  }, [active, narration, tokens.length]);

  const floorRevealed = floor.narration === narration ? floor.count : 0;
  const revealed = Math.max(floorRevealed, audioRevealed && audioRevealed > 0 ? audioRevealed : 0);
  return tokens.slice(0, Math.min(revealed, tokens.length)).join('');
}

// ──────────────────────────────────────────────────────────────
// MAIN
export function StoryScreen({
  scenes,
  activeSceneIndex,
  inBranch,
  finished,
  liveNarrationText,
  liveUserText,
  qaHistoryByScene,
  micMuted,
  micDenied,
  micLevel,
  agentState,
  onToggleMic,
  onTextQuestion,
  onExit,
}: StoryScreenProps) {
  const safeIndex = clamp(activeSceneIndex, 0, Math.max(0, scenes.length - 1));

  // Which scene the audio is currently on. Inferred from the REAL agent
  // transcript (matchSceneIndex over the scene narrations) so the feed can't
  // flip ahead of the voice; falls back to the server-driven clamped
  // activeSceneIndex when the transcript doesn't align (scene just flipped, a
  // bridge, or a Q&A answer in the buffer).
  const matched = matchSceneIndex(
    scenes.map((s) => s.narration_text),
    liveNarrationText ?? '',
  );
  const rawIndex = clamp(matched >= 0 ? matched : safeIndex, 0, Math.max(0, scenes.length - 1));

  // Monotonic high-water mark: never go backward within a session, so a brief
  // transcript misalignment can't yank the feed back a scene (jitter). Held in
  // state, adjusted DURING render (React's supported "store info from prior
  // renders" pattern). Resets when the lesson restarts (first scene id changes).
  const lessonKey = scenes[0]?.id ?? '';
  const [maxIndex, setMaxIndex] = useState(0);
  const [trackedLesson, setTrackedLesson] = useState(lessonKey);

  let currentIndex: number;
  if (trackedLesson !== lessonKey) {
    setTrackedLesson(lessonKey);
    setMaxIndex(rawIndex);
    currentIndex = rawIndex;
  } else if (rawIndex > maxIndex) {
    setMaxIndex(rawIndex);
    currentIndex = rawIndex;
  } else {
    currentIndex = maxIndex;
  }
  currentIndex = clamp(currentIndex, 0, Math.max(0, scenes.length - 1));

  // Derive the phase from real state. Drives the top-bar status, the stage
  // chip, and the composer copy — not core behavior.
  const phase: Phase = useMemo(() => {
    if (!inBranch && agentState === 'speaking') return 'reading';
    if (inBranch && agentState === 'thinking') return 'thinking';
    if (inBranch && agentState === 'listening' && !micMuted) return 'listening';
    if (inBranch && agentState === 'speaking') return 'reading';
    return 'paused';
  }, [inBranch, agentState, micMuted]);

  const scene = scenes[currentIndex];

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
        <div style={{ fontFamily: F_HEAD, fontStyle: 'italic', color: T.inkSoft }}>
          (no scenes — please try again)
        </div>
      </div>
    );
  }

  const status =
    phase === 'reading'
      ? 'NARRATING'
      : phase === 'listening'
        ? 'LISTENING'
        : phase === 'thinking'
          ? 'THINKING'
          : 'PAUSED';

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
      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 56,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 34px',
          borderBottom: `1px solid ${T.paperEdge}`,
        }}
      >
        <button
          type="button"
          onClick={onExit}
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
          style={{ fontFamily: F_HEAD, fontStyle: 'italic', color: T.ink, fontSize: 16 }}
        >
          Tonight&apos;s Lesson
        </div>
        <div
          style={{
            fontFamily: F_MONO,
            fontSize: 10,
            letterSpacing: '0.22em',
            color: T.inkSoft,
          }}
        >
          {status}
        </div>
      </div>

      {/* Main split */}
      <div
        style={{
          position: 'absolute',
          top: 56,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'grid',
          gridTemplateColumns: '47% 53%',
          // Bound the single row to the container height (minmax(0,1fr), NOT the
          // default `auto`) so the columns can't grow to their content — without
          // this the conversation feed expanded the row past the stage and the
          // composer fell off the bottom. minHeight:0 lets the grid itself shrink.
          gridTemplateRows: 'minmax(0, 1fr)',
          minHeight: 0,
          padding: '24px 34px 28px',
        }}
      >
        <StageFrame
          scene={scene}
          sceneIndex={currentIndex}
          sceneCount={scenes.length}
          phase={phase}
        />
        <ConversationPanel
          scenes={scenes}
          currentIndex={currentIndex}
          phase={phase}
          inBranch={inBranch}
          liveNarrationText={liveNarrationText}
          qaHistoryByScene={qaHistoryByScene}
          liveUserText={liveUserText}
          micLevel={micLevel}
          micMuted={micMuted}
          micDenied={micDenied}
          finished={finished}
          onToggleMic={onToggleMic}
          onTextQuestion={onTextQuestion}
        />
      </div>
    </div>
  );
}

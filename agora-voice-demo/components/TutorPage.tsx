'use client';

// Storybook tutor page.
//
// Three-stage state machine driven by the /api/lesson/start SSE stream:
//
//   input    — user picks a topic; Begin posts to /api/lesson/start
//   loading  — script_drafted → scenes_composed → image_ready × N → all_images_ready
//   story    — flips on session_started; word-by-word reveal + mic interrupt
//   done     — narration_complete
//   error    — SSE error event or fetch failure
//
// All of the Phase 3 audio + RTM machinery from the previous TutorPage is
// preserved verbatim:
//   - AgoraRTCProvider + lazy AgoraRTC.createClient (StrictMode-safe)
//   - useJoin / useLocalMicrophoneTrack / usePublish / useRemoteUsers
//   - useClientEvent('user-published', …) → manual subscribe + audioTrack.play()
//   - RTM client login + AgoraVoiceAI.init for AGENT_STATE_CHANGED / TRANSCRIPT_UPDATED
//   - End-of-Q&A silence-timer detector that POSTs /api/tutor/qa-ended
//
// What changed: the visual surface is the storybook (Input/Loading/Story
// components in ./tutor/) and we drive it off `/api/lesson/start` instead of
// `/api/tutor/start` so we get scenes + image URLs along with the narration
// session.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AgoraRTC, {
  AgoraRTCProvider,
  useClientEvent,
  useJoin,
  useLocalMicrophoneTrack,
  usePublish,
  useRTCClient,
  useRemoteUsers,
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
} from 'agora-rtc-react';
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  ChatMessagePriority,
  ChatMessageType,
  TranscriptHelperMode,
  type AgentTranscription,
  type ModuleError,
  type StateChangeEvent,
  type TranscriptHelperItem,
  type UserTranscription,
} from 'agora-agent-client-toolkit';
import type { RTMClient } from 'agora-rtm';

import { ScalingStage } from './tutor/ScalingStage';
import { InputScreen, PRESETS } from './tutor/InputScreen';
import { LoadingScreen, type LoadingState } from './tutor/LoadingScreen';
import { StoryScreen } from './tutor/StoryScreen';
import {
  mapTranscriptItems,
  latestAgentText,
  latestUserTurn,
  dedupeQaTurns,
  dropLeadingAgentTurns,
  coalesceConsecutiveTurns,
} from './tutor/transcript-mapping';
import { T, F_HEAD } from './tutor/theme';
import type { Scene, ServerEvent, ProgressSnapshot } from './tutor/theme';
import { applyNarrationText } from './tutor/scene-sync';
import { appendTypedTurn, postTypedBranchStarted } from './tutor/typed-qa-contract';

// End-of-Q&A silence windows — how long we wait after the agent settles before
// treating the digression as over and POSTing /api/tutor/qa-ended.
//   - AFTER A REAL ANSWER (agent was speaking → quiet): a GENEROUS follow-up
//     grace, then resume. First principles — a real storyteller, after answering
//     a child, pauses and lets the moment breathe; they don't snap back to
//     reading a beat later (the old 1.4s — "回主线太快", live-found 2026-06-01),
//     nor do they interrogate "any other questions?". ~4s of genuine silence is
//     the natural "you're done, let's read on" signal; a follow-up within that
//     window cancels the resume (block 3) and re-arms it after. The composer
//     still shows "Listening — just speak to interrupt" the whole time, so the
//     listener knows the floor is theirs.
//   - USER ASKED BUT AGENT WENT QUIET WITHOUT SPEAKING YET: wait longer for the
//     answer to BEGIN; repeated same-session interrupts can leave the agent in a
//     thinking/silent gap for >3s. Closing the branch here makes the app look
//     like it ignored the later question.
//   - NO USER QUESTION EVER ARRIVED: short fallback for false/back-channel
//     barges, so we don't strand the story paused.
const SILENCE_TIMEOUT_MS = 4000;
const SILENCE_PENDING_ANSWER_MS = 7000;
const SILENCE_NO_ANSWER_MS = 3000;
const QA_ERROR_FALLBACK =
  "I heard you, but I'm having trouble answering right now. Let me keep us with the story.";

type Stage = 'input' | 'loading' | 'story' | 'error';

interface SessionInfo {
  channel: string;
  agent_id: string;
  rtc_token: string;
  rtm_token: string;
  uid: number;
}

interface QaEntry {
  q: string;
  a: string;
  _branchKey?: string;
}

interface TutorPageProps {
  agoraAppId: string;
}

// ──────────────────────────────────────────────────────────────
// Inner component — runs inside <AgoraRTCProvider> so it can call the
// agora-rtc-react hooks.

function TutorPageInner({ agoraAppId }: TutorPageProps) {
  const client = useRTCClient();

  // ── stage machine ─────────────────────────────────────────
  const [stage, setStage] = useState<Stage>('input');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [inputText, setInputText] = useState<string>(PRESETS[0].prefill);

  // ── loading-screen progress state ─────────────────────────
  const [loading, setLoading] = useState<LoadingState>({
    scriptDrafted: false,
    scenesComposed: false,
    imagesReady: 0,
    totalScenes: 0,
    allImagesReady: false,
    videosReady: 0,
  });

  // ── scene + narration state ───────────────────────────────
  const [scenes, setScenes] = useState<Scene[]>([]);
  const scenesRef = useRef<Scene[]>([]);
  useEffect(() => {
    scenesRef.current = scenes;
  }, [scenes]);
  // The orchestrator emits segment_started / segment_completed using the
  // scene's id as the segment_id (one segment per scene). We track the
  // active scene index so StoryScreen can flip pages on segment_completed.
  const [activeSceneIndex, setActiveSceneIndex] = useState<number>(0);
  const activeSceneIndexRef = useRef(0);
  useEffect(() => {
    activeSceneIndexRef.current = activeSceneIndex;
  }, [activeSceneIndex]);
  // True once narration_complete fires — we stay on the story's last spread
  // (like the closing page of a book) instead of switching to a terminal card.
  const [finished, setFinished] = useState<boolean>(false);
  // BRANCH visual state — flipped by branch_started / branch_ended SSE events.
  const [inBranch, setInBranch] = useState<boolean>(false);
  // Per-scene QA history derived from the RTM transcript stream during
  // BRANCH. We append to the scene the branch is paused on.
  const [qaHistoryByScene, setQaHistoryByScene] = useState<
    Record<number, QaEntry[]>
  >({});

  // ── Agora session lifecycle ───────────────────────────────
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [rtmClient, setRtmClient] = useState<RTMClient | null>(null);
  const voiceAiRef = useRef<Awaited<ReturnType<typeof AgoraVoiceAI.init>> | null>(null);

  // ── Phase 3 detector refs (not state to avoid re-renders) ─
  const sessionIdRef = useRef<string | null>(null);
  const qaTurnCountRef = useRef(0);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAgentStateRef = useRef<string>('idle');
  // Live mirror of agentState, updated UNCONDITIONALLY in the AGENT_STATE_CHANGED
  // handler. prevAgentStateRef is only advanced inside the (session-gated)
  // transition-detector effect, so it can be stale when the agent's audio track
  // first publishes — agentStateRef is always current for the start-hushed check.
  const agentStateRef = useRef<string>('idle');
  // ── Seam instrumentation for the audio-latency bench. GATED on ?voicelog=1
  // so production stays silent. Emits a flat, greppable timeline the harness
  // parses via page.on('console'): "[seam] <perf_ms> <event> [detail]". perf_ms
  // is a monotonic clock (performance.now), so the bench derives T1/T2/T3 +
  // false-barge-in + STT-completeness from ground-truth VOICE events, not the
  // DOM (which drifts with copy) — see scripts/qa-bench/audio-barge-in.
  const voiceLogRef = useRef(false);
  useEffect(() => {
    try {
      voiceLogRef.current = new URLSearchParams(window.location.search).has('voicelog');
    } catch {
      /* no window (SSR) */
    }
  }, []);
  const seam = useCallback((event: string, detail?: string | number) => {
    if (!voiceLogRef.current) return;
    const d = detail == null ? '' : ` ${String(detail).replace(/\s+/g, ' ').slice(0, 60)}`;
    // eslint-disable-next-line no-console
    console.log(`[seam] ${Math.round(performance.now())} ${event}${d}`);
  }, []);
  const inBranchRef = useRef(false);
  // Scene index the BRANCH paused us on — so we know where to drop the
  // QA marginalia even if the orchestrator has already started the
  // bridge segment for the next scene by the time RTM gives us the
  // committed transcript.
  const branchAnchorRef = useRef<number>(0);
  const branchHistoryKeyRef = useRef<string | null>(null);
  // Wall-clock ms when the current BRANCH started (speaking → listening).
  // Used as the floor for filtering transcript items into qaTranscript so
  // narrator-side agent transcripts delivered BEFORE the listener interrupted
  // can't bleed into the qa_history we send to the resume planner. Reset to
  // null when the branch closes (qa-ended fires or teardown).
  // This is the B1 fix from 2026-05-30 — previously every `assistant.transcription`
  // from the narrator's say() ended up labelled "QA agent" and shipped to the
  // planner alongside the listener's real question, swelling 1 real Q&A turn
  // into 4-6 polluted turns.
  const branchStartedAtRef = useRef<number | null>(null);
  // True once we have seen an agent transcript in the current branch. Agora can
  // deliver answer text without a clean agentState='speaking' transition; if we
  // only key the resume timer off state, the no-answer fallback can fire while
  // the answer is still being spoken (live-found 2026-06-02).
  const answerSeenRef = useRef(false);
  // Monotonic branch generation id. Incremented on every barge-in so late
  // events (a silence-timer armed in branch N, a stale /qa-ended) can be dropped
  // once branch N+1 has opened — principled replacement for ad-hoc timer
  // clearing. Sent to the server in branch-started / qa-ended payloads so the
  // orchestrator can reject stale signals too (P1 "branch_id" guard).
  const branchGenRef = useRef(0);

  const [agentState, setAgentState] = useState<string>('idle');
  // The agent's remote audio track, captured on user-published. We locally
  // hush it the instant the listener starts speaking (agentState→listening) so
  // the narration goes quiet WITHOUT waiting for the server-side interrupt
  // round-trip — closing the "it kept talking over me" gap vs the 1:1 demo.
  const agentAudioTrackRef = useRef<IAgoraRTCRemoteUser['audioTrack']>(undefined);
  const [qaTranscript, setQaTranscript] = useState<
    Array<{ role: 'user' | 'agent'; text: string; ts: number }>
  >([]);
  // Live mirror of qaTranscript for the silence timer to read. The timer is
  // armed when the agent SETTLES (block 2) and fires 800-1400ms later; it must
  // post the LATEST transcript, not the value captured in the closure at
  // arm-time. Agora can finalize/extend the user transcript AFTER the agent
  // settles (STT lag) but BEFORE the timer fires — and the agentState effect
  // does NOT re-arm on that update (prev===cur===idle), so a closed-over
  // snapshot would post empty/partial qa_history → a REAL question gets treated
  // as no-question/back-channel and resumes without answering ("问了像没听到").
  // The shorter dynamic windows make this race more likely. Read the ref instead.
  const qaTranscriptRef = useRef<
    Array<{ role: 'user' | 'agent'; text: string; ts: number }>
  >([]);
  const lastLiveUserTurnRef = useRef<{ role: 'user'; text: string; ts: number } | null>(null);
  useEffect(() => {
    qaTranscriptRef.current = qaTranscript;
  }, [qaTranscript]);
  // What the agent is speaking RIGHT NOW (Agora's live agent transcript, grown
  // word-by-word as the TTS plays). Drives StoryScreen's audio-synced word
  // reveal so the on-screen cursor tracks the voice instead of a fixed timer.
  const [liveNarrationText, setLiveNarrationText] = useState<string | null>(null);
  // What the USER is saying RIGHT NOW (Agora grows this word-by-word as the STT
  // transcribes). Drives the live transcript echo in StoryScreen's voice
  // composer while listening, so the user sees their words land. Null when no
  // user transcript has arrived.
  const [liveUserText, setLiveUserText] = useState<string | null>(null);

  // The agent's RTC uid, captured from the first AGENT_STATE_CHANGED event so
  // sendText() (typed questions) targets the right participant. Defaults to the
  // orchestrator's agentUid ('123456').
  const agentUidRef = useRef<string>('123456');
  // Typed questions (text-mode QA). They aren't in the RTM transcript (the user
  // didn't speak), so we hold them here and merge them into qaTranscript by
  // timestamp, so a typed Q pairs with the agent's spoken answer in the feed.
  // Cleared when a new branch starts so they don't leak across interrupts.
  const typedTurnsRef = useRef<Array<{ role: 'user'; text: string; ts: number }>>([]);

  const abortRef = useRef<AbortController | null>(null);

  // Whenever the SSE-side QA transcript advances during a real BRANCH, fold
  // it into the per-scene QA history. We dedupe by the last (q,a) tuple so
  // we don't keep growing the visible history on the same exchange.
  useEffect(() => {
    if (!inBranchRef.current) return;
    // Reduce the transcript into ordered (q,a) tuples (user → agent pair).
    const pairs: QaEntry[] = [];
    let pendingQ: string | null = null;
    for (const t of qaTranscript) {
      if (t.role === 'user') {
        if (pendingQ !== null) {
          pairs.push({ q: pendingQ, a: '' });
        }
        pendingQ = t.text;
      } else if (t.role === 'agent') {
        pairs.push({ q: pendingQ ?? '', a: t.text });
        pendingQ = null;
      }
    }
    if (pendingQ !== null) {
      pairs.push({ q: pendingQ, a: '' });
    }
    const anchor = branchAnchorRef.current;
    const branchKey = branchHistoryKeyRef.current ?? `branch-${branchGenRef.current}`;
    const currentBranchPairs = pairs.map((pair, index) => ({
      ...pair,
      _branchKey: `${branchKey}:${index}`,
    }));
    const lastPair = currentBranchPairs[currentBranchPairs.length - 1];
    if (lastPair) seam('qa_pairs', `${anchor}:${currentBranchPairs.length}:${lastPair.a ? 'a' : 'q'}`);
    setQaHistoryByScene((prev) => {
      const existing = prev[anchor] ?? [];
      const withoutCurrentBranch = existing.filter(
        (entry) => !entry._branchKey?.startsWith(`${branchKey}:`),
      );
      return {
        ...prev,
        [anchor]: [...withoutCurrentBranch, ...currentBranchPairs].slice(-8),
      };
    });
  }, [qaTranscript, seam]);

  // ── StrictMode guard ──────────────────────────────────────
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (!cancelled) setIsReady(true);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
      setIsReady(false);
    };
  }, []);

  // ── useJoin / mic publish ─────────────────────────────────
  const joinConfig = useMemo(
    () => ({
      appid: agoraAppId,
      channel: sessionInfo?.channel ?? '',
      token: sessionInfo?.rtc_token ?? '',
      uid: sessionInfo?.uid ?? 0,
    }),
    [agoraAppId, sessionInfo],
  );

  const { isConnected: joinSuccess } = useJoin(
    joinConfig,
    Boolean(isReady && sessionInfo),
  );

  // Lazy mic acquisition: we don't ask the browser for microphone permission
  // until the user actually clicks the mic button. This avoids the noisy
  // `PERMISSION_DENIED` console error that fires on page load when the
  // listener hasn't expressed any intent to speak yet. micRequested flips to
  // true on the first onToggleMic call (below); once true, the hook acquires
  // the track and from then on we use setEnabled() for mute/unmute toggles.
  const [micRequested, setMicRequested] = useState(false);
  // True when the browser refused mic access (permission denied / no device).
  // Surfaced in the story footer so the user isn't left wondering why tapping
  // the mic did nothing. Cleared when they tap again to retry.
  const [micDenied, setMicDenied] = useState(false);
  const { localMicrophoneTrack, error: micError } = useLocalMicrophoneTrack(
    isReady && joinSuccess && micRequested,
  );
  usePublish([localMicrophoneTrack]);
  // Seam: mic track created = getUserMedia fired = the fake-mic WAV playhead
  // starts here. The bench anchors interrupt-onset off this (WAV lead silence).
  useEffect(() => {
    if (localMicrophoneTrack) seam('mic_live');
  }, [localMicrophoneTrack, seam]);
  useEffect(() => {
    if (micError) {
      console.warn('[tutor] mic acquisition failed', micError.message);
      setMicDenied(true);
    }
  }, [micError]);

  useRemoteUsers(); // present for parity; we manage subscribe via the event below.

  // Manual subscribe+play — see legacy notes: <RemoteUser playAudio> doesn't
  // reliably create the hidden <audio> in this config.
  useClientEvent(
    client,
    'user-published',
    async (user: IAgoraRTCRemoteUser, mediaType: 'audio' | 'video') => {
      if (mediaType !== 'audio') return;
      try {
        await client.subscribe(user, mediaType);
        const track = user.audioTrack;
        if (!track) return;
        agentAudioTrackRef.current = track;
        // If the listener is already mid-interruption when the track arrives,
        // start it hushed so a just-published segment can't blast over them.
        track.setVolume(agentStateRef.current === 'listening' ? 0 : 100);
        try {
          await track.play();
        } catch (playErr) {
          console.warn('[tutor] audioTrack.play() rejected', playErr);
        }
      } catch (subErr) {
        console.warn('[tutor] subscribe failed', subErr);
      }
    },
  );
  useClientEvent(
    client,
    'user-unpublished',
    (user: IAgoraRTCRemoteUser, mediaType: 'audio' | 'video') => {
      if (mediaType === 'audio') {
        user.audioTrack?.stop();
        agentAudioTrackRef.current = undefined;
      }
    },
  );

  // INSTANT BARGE-IN HUSH: the moment the listener starts speaking (agent state
  // flips to 'listening'), drop the agent's remote-audio volume to 0 LOCALLY —
  // so residual/queued narration goes silent immediately, without waiting for
  // the server-side session.interrupt() round-trip. Restore to full volume when
  // the agent speaks again (resumed narration OR the answer). This is what makes
  // barge-in feel as snappy as the raw 1:1 demo despite the say()-injection model.
  useEffect(() => {
    const track = agentAudioTrackRef.current;
    if (!track) return;
    if (agentState === 'listening') {
      track.setVolume(0);
      seam('hush', 0);
    } else if (agentState === 'speaking') {
      track.setVolume(100);
      seam('hush', 100);
    }
  }, [agentState, seam]);

  // Local mute helper — the mute control in StoryScreen toggles this. Keeps
  // the track lifecycle owned by useLocalMicrophoneTrack (no manual close).
  //
  // ALWAYS-ON (matches raw Agora 1:1): the mic goes live the moment the story
  // session connects, so the listener can simply START TALKING to interrupt —
  // no tap-to-talk gate. Push-to-talk was clipping speech (the mic engaged
  // AFTER the user had already started, so STT lost the opening words, and
  // muting cut the tail) which made our STT feel far worse than 1:1. Agora's
  // server-side VAD + interrupt thresholds + AEC gate false barge-ins, same as
  // 1:1. The user can still mute via the composer. Tracked state is the source
  // of truth; the effect below syncs it to the AgoraRTC track via setEnabled().
  const [micMuted, setMicMuted] = useState(false);
  // Acquire the mic as soon as the RTC session is joined (voice-first product —
  // the user clicked "Begin" expecting to talk, so prompting now is expected).
  useEffect(() => {
    if (isReady && joinSuccess) setMicRequested(true);
  }, [isReady, joinSuccess]);
  useEffect(() => {
    if (!localMicrophoneTrack) return;
    // ignore the promise; setEnabled is idempotent and the SDK queues it
    void localMicrophoneTrack.setEnabled(!micMuted);
  }, [localMicrophoneTrack, micMuted]);

  // Live mic amplitude (0..1) for the Voice Orb's level ring. Polled at ~12fps
  // (80ms) — fast enough to feel alive, slow enough not to thrash React. Only
  // runs while the mic is actually live; muted/absent → 0 so the ring rests.
  // This is also the *visible* echo guard: if the agent's own voice ever leaks
  // into a hot mic, the ring blooms while the user is silent — you can see it.
  const [micLevel, setMicLevel] = useState(0);
  useEffect(() => {
    if (!localMicrophoneTrack || micMuted) {
      setMicLevel(0);
      return;
    }
    const id = setInterval(() => {
      try {
        setMicLevel(localMicrophoneTrack.getVolumeLevel?.() ?? 0);
      } catch {
        // track may be mid-teardown; ignore
      }
    }, 80);
    return () => clearInterval(id);
  }, [localMicrophoneTrack, micMuted]);
  const onToggleMic = useCallback(() => {
    // Tapping clears any prior denial so the browser can re-prompt (e.g. the
    // user fixed a blocked permission and wants to retry).
    setMicDenied(false);
    // First click on the mic button is the user's explicit "I want to talk"
    // signal — trigger the browser permission prompt now and unmute so they
    // can speak immediately if they grant access. Subsequent clicks just
    // toggle mute on the already-acquired track.
    if (!micRequested) {
      setMicRequested(true);
      setMicMuted(false);
      return;
    }
    setMicMuted((m) => !m);
  }, [micRequested]);

  const beginVoiceBranch = useCallback(
    (
      reason: 'state' | 'transcript' | 'typed',
      startedAt = Date.now(),
      opts: { interruptAudio?: boolean } = {},
    ) => {
      if (!sessionInfo || !sessionIdRef.current || inBranchRef.current) return null;
      const gen = ++branchGenRef.current;
      inBranchRef.current = true;
      qaTurnCountRef.current = 0;
      branchAnchorRef.current = activeSceneIndexRef.current;
      branchHistoryKeyRef.current = `b${gen}`;
      branchStartedAtRef.current = startedAt;
      typedTurnsRef.current = [];
      lastLiveUserTurnRef.current = null;
      answerSeenRef.current = false;
      qaTranscriptRef.current = [];
      setQaTranscript([]);
      setInBranch(true);
      agentAudioTrackRef.current?.setVolume(0);
      seam('hush', 0);
      seam('branch_post', `${gen}:${reason}`);
      // Returns the POST promise so callers that must SEQUENCE work after the
      // server-side interrupt lands (typed QA — see onTextQuestion) can await it.
      // Voice callers ignore the return and fire-and-forget.
      return fetch('/api/tutor/branch-started', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          branch_id: gen,
          interrupt_audio: opts.interruptAudio !== false,
        }),
      })
        .then(() => {})
        .catch((err) => console.warn('[tutor] /branch-started fetch error', err));
    },
    [sessionInfo, seam],
  );

  const enterLocalBranch = useCallback(
    async (reason: 'typed', startedAt: number) => {
      if (!sessionInfo || !sessionIdRef.current) return null;
      const wasAlreadyInBranch = inBranchRef.current;
      const gen = ++branchGenRef.current;
      inBranchRef.current = true;
      qaTurnCountRef.current = 0;
      branchAnchorRef.current = activeSceneIndexRef.current;
      branchHistoryKeyRef.current = `b${gen}`;
      branchStartedAtRef.current = startedAt;
      if (!wasAlreadyInBranch) typedTurnsRef.current = [];
      lastLiveUserTurnRef.current = null;
      answerSeenRef.current = false;
      if (!wasAlreadyInBranch) {
        qaTranscriptRef.current = [];
        setQaTranscript([]);
      }
      setInBranch(true);
      agentAudioTrackRef.current?.setVolume(0);
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      seam('hush', 0);
      const posted = await postTypedBranchStarted({
        sessionId: sessionIdRef.current,
        branchId: gen,
        // Typed QA must flush any in-flight narration audio before sendText;
        // the helper's default is conservative for older tests, so pass the
        // live option here.
        interruptAudio: true,
      });
      seam(posted ? 'branch_post' : 'branch_err', `${gen}:${reason}`);
      return posted ? gen : null;
    },
    [sessionInfo, seam],
  );

  // Typed question (text-mode QA): interrupt the story, show the question, and
  // send it to the agent via the toolkit's sendText so it answers exactly like
  // a spoken Q&A — then the existing silence-timer → qa-ended path resumes.
  const onTextQuestion = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || !sessionInfo) return;
      const now = Date.now();
      const typedTurn = { role: 'user' as const, text: q, ts: now };
      seam('typed_txt', q);
      // Enter a branch (pause narration + locally hush TTS) if we're not already
      // in one — the same effect a voice barge-in has. CRITICAL ORDERING: the
      // buffered narration TTS keeps PLAYING until session.interrupt() flushes it
      // (sendText alone does NOT interrupt say()-injected narration — proven live
      // 2026-06-01: the agent's branch transcript was the narration, not a reply,
      // so the answer never got a voice turn → "无视我的QA"). So we interrupt the
      // narration FIRST (interruptAudio:true), AWAIT the server ping so the flush
      // has landed, then sendText — the reply now plays into a cleared TTS. The
      // earlier interruptAudio:false was an over-correction for a CONCURRENT
      // interrupt cutting the reply; sequencing (interrupt → settle → send) fixes
      // both: the narration is gone AND the interrupt is done before the reply.
      // Even if we're already in a branch, a rapid follow-up must interrupt the
      // current answer/bridge before sending new text, or the sendText can be
      // swallowed behind the still-playing TTS.
      const branchGen = await enterLocalBranch('typed', now);
      if (branchGen === null) return;
      // The server now awaits session.interrupt(); leave a small buffer for
      // Agora's transcript stream to settle before the reply starts.
      await new Promise((r) => setTimeout(r, 600));
      // Record the typed question so it shows in the feed + pairs with the answer.
      typedTurnsRef.current.push(typedTurn);
      setQaTranscript((prev) => {
        const next = appendTypedTurn(prev, typedTurn);
        qaTranscriptRef.current = next;
        return next;
      });
      // Send it to the agent — it replies with TTS + a transcript turn. The
      // typed harness can submit within ~1s of the first segment, before
      // AgoraVoiceAI.init has finished its RTM subscribe path; wait briefly
      // instead of calling getInstance(), which throws when not initialized.
      let ai = voiceAiRef.current;
      for (let i = 0; !ai && i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        ai = voiceAiRef.current;
      }
      seam('send_uid', String(agentUidRef.current));
      if (ai) {
        void ai
          .sendText(agentUidRef.current, {
            messageType: ChatMessageType.TEXT,
            priority: ChatMessagePriority.INTERRUPTED,
            responseInterruptable: true,
            text: q,
          })
          .then(() => seam('sent_ok'))
          .catch((err) => {
            seam('send_err', String(err?.message ?? err).slice(0, 50));
            console.warn('[tutor] sendText failed', err);
          });
      } else {
        seam('send_err', 'no AgoraVoiceAI instance');
      }
    },
    [sessionInfo, enterLocalBranch, seam],
  );

  const scheduleQaEnded = useCallback(
    (gen: number, settleMs: number) => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        // Drop a stale timer: a newer branch opened since this one was armed.
        if (gen !== branchGenRef.current) {
          silenceTimerRef.current = null;
          return;
        }
        seam('qa_post', gen);
        // Read the LIVE transcript (ref), NOT the closed-over qaTranscript from
        // the render that armed this timer — see qaTranscriptRef rationale.
        let snapshot = qaTranscriptRef.current.slice(-10);
        if (!snapshot.some((turn) => turn.role === 'user') && lastLiveUserTurnRef.current) {
          snapshot = [...snapshot, lastLiveUserTurnRef.current].sort((a, b) => a.ts - b.ts).slice(-10);
          qaTranscriptRef.current = snapshot;
        }
        void fetch('/api/tutor/qa-ended', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionIdRef.current,
            qa_history: snapshot,
            branch_id: gen,
          }),
        }).catch((err) => console.warn('[tutor] /qa-ended fetch error', err));
        inBranchRef.current = false;
        // Close the branch window: subsequent narration text won't be added
        // to qa_history until the listener interrupts again.
        branchStartedAtRef.current = null;
        answerSeenRef.current = false;
        silenceTimerRef.current = null;
      }, settleMs);
    },
    [seam],
  );

  // ── RTM client lifecycle ──────────────────────────────────
  useEffect(() => {
    if (!sessionInfo) {
      setRtmClient(null);
      return;
    }
    let cancelled = false;
    let createdClient: RTMClient | null = null;
    (async () => {
      try {
        const { default: AgoraRTM } = await import('agora-rtm');
        const c: RTMClient = new AgoraRTM.RTM(
          agoraAppId,
          String(sessionInfo.uid),
        );
        await c.login({ token: sessionInfo.rtm_token });
        await c.subscribe(sessionInfo.channel);
        if (cancelled) {
          try {
            await c.logout();
          } catch {
            // ignore
          }
          return;
        }
        createdClient = c;
        setRtmClient(c);
      } catch (err) {
        if (!cancelled) {
          console.warn('[tutor] rtm login failed', err);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (createdClient) {
        createdClient.logout().catch(() => {
          // ignore
        });
      }
      setRtmClient(null);
    };
  }, [sessionInfo, agoraAppId]);

  // ── AgoraVoiceAI subscriptions ────────────────────────────
  useEffect(() => {
    if (!isReady || !joinSuccess || !rtmClient || !sessionInfo) return;
    let cancelled = false;

    (async () => {
      try {
        const ai = await AgoraVoiceAI.init({
          rtcEngine: client,
          rtmConfig: { rtmEngine: rtmClient },
          renderMode: TranscriptHelperMode.TEXT,
          enableLog: false,
        });

        if (cancelled) {
          try {
            if (AgoraVoiceAI.getInstance() === ai) {
              ai.unsubscribe();
              ai.destroy();
            }
          } catch {
            // ignore
          }
          return;
        }
        voiceAiRef.current = ai;

        ai.on(
          AgoraVoiceAIEvents.AGENT_STATE_CHANGED,
          (_agentUserId: string, event: StateChangeEvent) => {
            if (_agentUserId) agentUidRef.current = String(_agentUserId);
            agentStateRef.current = String(event.state);
            seam('state', String(event.state));
            seam('agent_uid', String(_agentUserId));
            setAgentState(String(event.state));
          },
        );

        const localUid = String(sessionInfo.uid);
        ai.on(
          AgoraVoiceAIEvents.TRANSCRIPT_UPDATED,
          (
            items: TranscriptHelperItem<
              Partial<UserTranscription | AgentTranscription>
            >[],
          ) => {
            // C1 (subtitle attribution) + C2 (qa pollution) both live in
            // mapTranscriptItems — a pure, unit-tested function. See
            // components/tutor/transcript-mapping.ts + .test.ts. Keep this call
            // site thin so the bugs can't regress without a test failing.
            const committed = mapTranscriptItems(items, {
              localUid,
              branchStartedAt: branchStartedAtRef.current,
              narrationTexts: scenesRef.current.map((scene) => scene.narration_text),
            });
            // Merge typed questions (not in the RTM transcript) by timestamp so
            // a typed Q pairs with the agent's spoken answer.
            // Agora echoes sendText() back as a user.transcription, so a typed
            // question lands in BOTH `committed` and typedTurnsRef — dedupeQaTurns
            // collapses that into one bubble (live-verified regression).
            const merged = typedTurnsRef.current.length
              ? dedupeQaTurns(
                  [...committed, ...typedTurnsRef.current].sort((a, b) => a.ts - b.ts),
                )
              : committed;
            // Clean the panel to a storyteller's natural shape: drop the leftover
            // narration tail that finalized after the barge-in (phantom no-question
            // "answer"), then coalesce the chunked agent transcript so one reply is
            // ONE bubble, not three. (Both live-found 2026-06-01.)
            const cleaned = coalesceConsecutiveTurns(dropLeadingAgentTurns(merged));
            qaTranscriptRef.current = cleaned;
            setQaTranscript(cleaned);
            if (inBranchRef.current && cleaned.some((turn) => turn.role === 'agent')) {
              answerSeenRef.current = true;
              // A real answer transcript is the authoritative "answer started"
              // signal. Re-arm from the latest transcript chunk so the story
              // does not resume over the tail of the spoken answer when Agora
              // omits/shortens the agentState='speaking' phase.
              scheduleQaEnded(branchGenRef.current, SILENCE_TIMEOUT_MS);
            }
            // Feed the live agent transcript to the word-reveal so captions
            // track the actual voice (audio-synced) rather than a fixed timer.
            const agentNow = latestAgentText(items, localUid);
            setLiveNarrationText(agentNow);
            // Diagnostic: surface any agent transcript that arrives WHILE a branch
            // is open — i.e. a reply to the question (vs narration). If none ever
            // logs, the agent isn't producing a reply at all.
            if (inBranchRef.current && agentNow) seam('agent_reply', agentNow);
            // Feed the live user transcript to the voice composer so the
            // in-progress question echoes back as the user speaks.
            const liveUserTurn = latestUserTurn(items, localUid);
            const ut = liveUserTurn?.text ?? null;
            if (liveUserTurn && !inBranchRef.current) {
              beginVoiceBranch('transcript', liveUserTurn.ts);
            }
            if (liveUserTurn) {
              lastLiveUserTurnRef.current = {
                role: 'user',
                text: liveUserTurn.text,
                ts: liveUserTurn.ts,
              };
            }
            setLiveUserText(ut);
            if (ut) seam('user_txt', ut);
          },
        );

        ai.on(
          AgoraVoiceAIEvents.AGENT_ERROR,
          (_agentUserId: string, error: ModuleError) => {
            console.warn(
              '[tutor] agent-error',
              error.type,
              error.code,
              error.message,
            );
            seam('agent_error', `${error.type}:${error.code}`);
            if (inBranchRef.current && qaTranscriptRef.current.some((turn) => turn.role === 'user')) {
              const hasAgentTurn = qaTranscriptRef.current.some((turn) => turn.role === 'agent');
              if (!hasAgentTurn) {
                const next = [
                  ...qaTranscriptRef.current,
                  { role: 'agent' as const, text: QA_ERROR_FALLBACK, ts: Date.now() },
                ];
                qaTranscriptRef.current = next;
                setQaTranscript(next);
              }
            }
          },
        );

        ai.subscribeMessage(sessionInfo.channel);
      } catch (err) {
        if (!cancelled) {
          console.warn('[tutor] AgoraVoiceAI init failed', err);
        }
      }
    })();

    return () => {
      cancelled = true;
      const ai = voiceAiRef.current;
      voiceAiRef.current = null;
      try {
        if (ai) {
          ai.unsubscribe();
          ai.destroy();
        }
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, joinSuccess, rtmClient, sessionInfo, beginVoiceBranch, scheduleQaEnded]);

  // ── End-of-Q&A detector ───────────────────────────────────
  useEffect(() => {
    const prev = prevAgentStateRef.current;
    const cur = agentState;
    prevAgentStateRef.current = cur;

    if (!sessionInfo || !sessionIdRef.current) return;

    // 1. BARGE-IN — the listener started speaking. ANY transition INTO
    // 'listening' is a barge-in. The old `prev === 'speaking'` guard MISSED
    // narration-gap barge-ins: narration say() registers as silent/idle, so a
    // barge-in there is `silent→listening` → the POST never fired → the server
    // never entered the branch and narration just advanced with no answer
    // (live-found via the seam timeline, 2026-06-01). `!inBranch` keeps a
    // follow-up inside an open branch in block 3, not re-entry.
    if (!inBranchRef.current && cur === 'listening') {
      beginVoiceBranch('state');
    }

    // 2. AGENT SETTLED → start the resume countdown. Fires when, inside a
    // branch, the agent goes quiet (idle/silent) after speaking (answer done),
    // thinking (no answer produced — e.g. an untranscribed/false barge), OR
    // listening (user spoke then stopped with no agent turn). Covering all
    // three is REQUIRED now that entry is broadened: otherwise a no-answer
    // branch never arms the timer and strands the narrator paused.
    if (
      inBranchRef.current &&
      (prev === 'speaking' || prev === 'thinking' || prev === 'listening') &&
      (cur === 'idle' || cur === 'silent')
    ) {
      qaTurnCountRef.current++;
      const gen = branchGenRef.current;
      // Window depends on whether the answer already played: speaking→quiet =
      // answer done → short follow-up grace; thinking/listening→quiet = answer
      // may still be composing → wait long enough for it to BEGIN (block 3
      // cancels this the instant the agent speaks). Only fires as the resume
      // fallback when no answer ever comes.
      const hasUserTurn =
        qaTranscriptRef.current.some((turn) => turn.role === 'user') ||
        lastLiveUserTurnRef.current !== null;
      const settleMs =
        prev === 'speaking' || answerSeenRef.current
          ? SILENCE_TIMEOUT_MS
          : hasUserTurn
            ? SILENCE_PENDING_ANSWER_MS
            : SILENCE_NO_ANSWER_MS;
      scheduleQaEnded(gen, settleMs);
    }

    // 3. AGENT ANSWERING or USER FOLLOW-UP → cancel the resume countdown. The
    // agent entering 'speaking' means the reply has STARTED (the no-answer timer
    // armed during its thinking gap must NOT fire mid-answer); 'listening' means
    // the listener is still talking. After the answer finishes, speaking→idle
    // re-arms the (short, after-answer) timer via block 2.
    if (
      inBranchRef.current &&
      (cur === 'listening' || cur === 'speaking') &&
      silenceTimerRef.current
    ) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    // qaTranscript intentionally NOT a dep: the timer reads qaTranscriptRef for
    // the live value, so this effect needn't re-run on every transcript update.
  }, [agentState, sessionInfo, activeSceneIndex, seam, beginVoiceBranch, scheduleQaEnded]);

  // ── teardown ──────────────────────────────────────────────
  const teardownSession = useCallback(() => {
    setSessionInfo(null);
    sessionIdRef.current = null;
    setAgentState('idle');
    setQaTranscript([]);
    setLiveUserText(null);
    typedTurnsRef.current = [];
    lastLiveUserTurnRef.current = null;
    answerSeenRef.current = false;
    inBranchRef.current = false;
    branchStartedAtRef.current = null;
    branchHistoryKeyRef.current = null;
    qaTurnCountRef.current = 0;
    setInBranch(false);
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // ── SSE event handling ────────────────────────────────────
  const handleEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case 'script_drafted':
          setLoading((s) => ({ ...s, scriptDrafted: true }));
          return;

        case 'scenes_composed':
          setLoading((s) => ({
            ...s,
            scenesComposed: true,
            totalScenes: e.scenes.length,
          }));
          setScenes(
            e.scenes.map((sc) => ({
              ...sc,
              // Normalize so headline is always a tuple even if the
              // backend ever ships a single-string variant.
              headline: [
                sc.headline?.[0] ?? '',
                sc.headline?.[1] ?? '',
              ] as [string, string],
            })),
          );
          return;

        case 'image_ready':
          setScenes((prev) =>
            prev.map((sc) =>
              sc.id === e.scene_id ? { ...sc, image_url: e.image_url } : sc,
            ),
          );
          setLoading((s) => ({ ...s, imagesReady: s.imagesReady + 1 }));
          return;

        case 'image_failed':
          console.warn('[tutor] image_failed', e.scene_id, e.error);
          // Bump the counter so the LoadingScreen step closes even if some
          // images failed — we don't want to wedge forever waiting for a
          // success that won't come. The scene just renders the placeholder.
          setLoading((s) => ({ ...s, imagesReady: s.imagesReady + 1 }));
          return;

        case 'all_images_ready':
          setLoading((s) => ({ ...s, allImagesReady: true }));
          return;

        case 'video_ready':
          // Hot-swap the scene's still image for its animated clip. Scene 1
          // arrives before the story stage; scenes 2..N stream in during
          // narration and replace the <img> mid-read with no interruption.
          setScenes((prev) =>
            prev.map((sc) =>
              sc.id === e.scene_id ? { ...sc, video_url: e.video_url } : sc,
            ),
          );
          setLoading((s) => ({ ...s, videosReady: s.videosReady + 1 }));
          return;

        case 'video_failed':
          // Non-fatal — the scene keeps its static illustration.
          console.warn('[tutor] video_failed', e.scene_id, e.error);
          return;

        case 'all_videos_ready':
          return;

        case 'session_started': {
          const uidNumber = parseInt(e.client_uid, 10);
          if (!Number.isFinite(uidNumber)) {
            setStage('error');
            setErrorMsg(
              `client_uid is not a valid numeric string: ${e.client_uid}`,
            );
            return;
          }
          sessionIdRef.current = e.session_id;
          setSessionInfo({
            channel: e.channel,
            agent_id: e.agent_id,
            rtc_token: e.rtc_token,
            rtm_token: e.rtm_token,
            uid: uidNumber,
          });
          // Flip into story stage — the session is up. Audio will start
          // flowing as soon as Agora joins; the page is already on the
          // book spread so the very first words feel responsive.
          setStage('story');
          return;
        }

        case 'snapshot': {
          const snapshot: ProgressSnapshot = e.snapshot;
          if (!sessionIdRef.current) {
            sessionIdRef.current = snapshot.session_id;
          }
          // If the orchestrator already advanced past the first scene
          // before our UI mounted, jump the visible spread to match.
          if (snapshot.main_line.current_segment_id) {
            setActiveSceneIndex((curr) => {
              const idx = scenes.findIndex(
                (sc) => sc.id === snapshot.main_line.current_segment_id,
              );
              return idx >= 0 ? idx : curr;
            });
          }
          return;
        }

        case 'segment_started': {
          seam('segment', e.segment_id);
          // Narration (re)starting = any QA branch is OVER. Close the capture
          // window so the resumed narration's transcript isn't mis-committed as
          // a QA answer (the "IN ANSWER TO YOU" duplicate-of-narration bug,
          // live-found 2026-05-31). The silence-timer alone misses this when the
          // agent goes answer→narration with no idle gap (typed questions).
          if (inBranchRef.current || branchStartedAtRef.current !== null) {
            inBranchRef.current = false;
            branchStartedAtRef.current = null;
            setInBranch(false);
            // The QA is over once narration resumes — kill any pending silence
            // timer so it can't fire a late/duplicate /qa-ended for a branch
            // that's already closed here.
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          }
          // BARGE-IN HUSH RESTORE (belt for the agentState effect): narration is
          // (re)starting, so the agent's audio must be audible. The effect only
          // restores on the 'speaking' transition, which can be missed if a
          // resume doesn't emit a fresh 'speaking' event after a 'listening'
          // blip — that would leave the track stuck at volume 0. segment_started
          // is the reliable resume signal, so restore here unconditionally.
          agentAudioTrackRef.current?.setVolume(100);
          // Subtitle follows the SPOKEN text: when the resume-planner rewrites a
          // segment (e.g. switches it to Chinese), segment_started carries the
          // new text — sync it into the displayed scene so the subtitle matches
          // the audio instead of showing the stale original (the 2026-05-31
          // "voice Chinese / subtitle English" bug). No-op for a normal run.
          setScenes((prev) => applyNarrationText(prev, e.segment_id, e.text));
          setActiveSceneIndex((curr) => {
            // Prefer matching by id (segment_id == scene.id under the
            // current orchestrator), fall back to the numeric index.
            const idx = scenes.findIndex((sc) => sc.id === e.segment_id);
            if (idx >= 0) return idx;
            if (Number.isFinite(e.segment_index)) return e.segment_index;
            return curr;
          });
          return;
        }

        case 'segment_completed': {
          // Auto-advance: bump the index so the next scene is visible.
          // We clamp to within scenes.length in the StoryScreen itself.
          setActiveSceneIndex((curr) => {
            const idx = scenes.findIndex((sc) => sc.id === e.segment_id);
            const advanceFrom = idx >= 0 ? idx : curr;
            return advanceFrom + 1;
          });
          return;
        }

        case 'narration_complete':
          // Stay on the story stage — the last spread becomes the closing
          // page. We only tear down the live Agora connection and flag done.
          setFinished(true);
          teardownSession();
          return;

        case 'branch_started':
          // Client-side branch entry is immediate and authoritative. The SSE is
          // only confirmation; if an old branch_started arrives after the
          // client already closed that branch, do not resurrect inBranchRef and
          // block later interrupts.
          if (!inBranchRef.current && branchStartedAtRef.current === null) {
            return;
          }
          setInBranch(true);
          inBranchRef.current = true;
          branchAnchorRef.current = activeSceneIndex;
          return;

        case 'branch_ended':
          setInBranch(false);
          inBranchRef.current = false;
          // Close the QA capture window too — otherwise resumed narration after
          // a (voice) barge-in stays "inside the branch" and pollutes qa_history.
          branchStartedAtRef.current = null;
          // Server already closed the branch — cancel any armed silence timer so
          // it can't fire a duplicate /qa-ended after the fact.
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          return;

        case 'active_scene_changed': {
          // The resume planner just decided which scene to be on after Q&A —
          // could rewind (restart), stay (continue), or advance (skip).
          // Authoritative override of activeSceneIndex.
          const idx = scenes.findIndex((sc) => sc.id === e.scene_id);
          if (idx >= 0) {
            setActiveSceneIndex(idx);
          }
          return;
        }

        case 'bridge_started':
          seam('bridge', 'started');
          // The answer is done once the resume bridge starts. Keep the bridge
          // out of the QA transcript; otherwise it can be coalesced into the
          // "IN ANSWER TO YOU" bubble and look like the tutor answered with
          // story prose before/after the actual answer.
          if (inBranchRef.current || branchStartedAtRef.current !== null) {
            setInBranch(false);
            inBranchRef.current = false;
            branchStartedAtRef.current = null;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          }
          return;

        case 'bridge_completed':
          seam('bridge', 'completed');
          return;

        case 'comprehension_changed':
          // Informational. Nothing visual to do.
          return;

        case 'error':
          setStage('error');
          setErrorMsg(e.message);
          teardownSession();
          return;

        default: {
          // Exhaustiveness check — TypeScript will flag any new SSE event
          // type that we forget to handle.
          const _exhaustive: never = e;
          void _exhaustive;
        }
      }
    },
    [scenes, activeSceneIndex, teardownSession, seam],
  );

  // ── start the SSE pipeline ────────────────────────────────
  const onBegin = useCallback(
    async (text: string) => {
      setInputText(text);
      setStage('loading');
      setErrorMsg(null);
      setLoading({
        scriptDrafted: false,
        scenesComposed: false,
        imagesReady: 0,
        totalScenes: 0,
        allImagesReady: false,
        videosReady: 0,
      });
      setScenes([]);
      setActiveSceneIndex(0);
      setQaHistoryByScene({});
      setFinished(false);
      setInBranch(false);
      teardownSession();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/lesson/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input_text: text }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.text();
          setStage('error');
          setErrorMsg(`Start failed (${res.status}): ${err.slice(0, 200)}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            try {
              const parsed = JSON.parse(trimmed.slice(6)) as ServerEvent;
              handleEvent(parsed);
            } catch (err) {
              console.warn('[tutor] bad SSE line', trimmed, err);
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setStage('error');
        setErrorMsg((err as Error).message);
      } finally {
        abortRef.current = null;
      }
    },
    [handleEvent, teardownSession],
  );

  const onExit = useCallback(() => {
    abortRef.current?.abort();
    teardownSession();
    setStage('input');
    setErrorMsg(null);
  }, [teardownSession]);

  // ── render ────────────────────────────────────────────────
  return (
    <ScalingStage>
      <div
        key={stage}
        style={{
          position: 'absolute',
          inset: 0,
          animation: 'stageFade 0.55s ease',
        }}
      >
        {stage === 'input' && (
          <InputScreen onBegin={onBegin} initialText={inputText} />
        )}
        {stage === 'loading' && <LoadingScreen state={loading} />}
        {stage === 'story' && (
          <StoryScreen
            scenes={scenes}
            activeSceneIndex={activeSceneIndex}
            inBranch={inBranch}
            finished={finished}
            liveNarrationText={liveNarrationText}
            liveUserText={liveUserText}
            qaHistoryByScene={qaHistoryByScene}
            micMuted={micMuted}
            micDenied={micDenied}
            micLevel={micLevel}
            agentState={agentState}
            onToggleMic={onToggleMic}
            onTextQuestion={onTextQuestion}
            onExit={onExit}
          />
        )}
        {stage === 'error' && (
          <ErrorScreen message={errorMsg ?? 'something went wrong'} onExit={onExit} />
        )}
      </div>
      <style>{`@keyframes stageFade { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </ScalingStage>
  );
}

// ──────────────────────────────────────────────────────────────
// Terminal error screen. (There is no terminal "done" screen — when narration
// finishes we stay on the story's last spread, like the closing page of a
// book; see StoryScreen's `finished` prop.)

function ErrorScreen({
  message,
  onExit,
}: {
  message: string;
  onExit: () => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: T.paper,
        color: T.ink,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 16,
        padding: 40,
        fontFamily: F_HEAD,
        textAlign: 'center',
      }}
    >
      <h2
        style={{
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontWeight: 500,
          fontSize: 36,
          margin: 0,
          color: T.rose,
        }}
      >
        Something interrupted the story.
      </h2>
      <p
        style={{
          fontStyle: 'italic',
          color: T.inkSoft,
          margin: 0,
          maxWidth: 560,
          fontSize: 16,
        }}
      >
        {message}
      </p>
      <button
        type="button"
        onClick={onExit}
        style={{
          background: T.ink,
          color: T.paper,
          border: 'none',
          padding: '10px 22px',
          fontFamily: F_HEAD,
          fontStyle: 'italic',
          fontSize: 16,
          cursor: 'pointer',
          borderRadius: 2,
        }}
      >
        ← back to start
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Outer wrapper — owns the RTC client lifetime. useState lazy initializer is
// StrictMode-safe (useMemo is not — see AGENTS.md).

export default function TutorPage(props: TutorPageProps) {
  const [client] = useState<IAgoraRTCClient>(() =>
    AgoraRTC.createClient({ codec: 'vp8', mode: 'rtc' }),
  );
  return (
    <AgoraRTCProvider client={client}>
      <TutorPageInner {...props} />
    </AgoraRTCProvider>
  );
}

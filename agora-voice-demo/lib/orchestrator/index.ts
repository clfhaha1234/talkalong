// Orchestrator — top-level entry point. Owns one tutor session end-to-end.
//
// Phase 1: build segments from text, start an Agora agent session, run
// narrator, stop session. Persona is the "Ada" tutor reused from
// app/api/invite-agent/route.ts so Phase 1 doesn't accidentally rewrite the
// persona while we're still proving the loop.

import {
  Agent,
  AgoraClient,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
  type AgentSession,
  type FillerWordsConfig,
  type TurnDetectionConfig,
  type AdvancedFeatures,
  type SessionParams,
} from 'agora-agent-server-sdk';
import { RtcRole, RtcTokenBuilder } from 'agora-token';

import { splitToSegments } from './splitter';
import { ProgressState } from './progress-state';
import { runNarration, type RunNarrationOptions } from './narrator';
import { planResume } from './resume-planner';
import { attachSessionLogger, closeSessionLogger } from './session-logger';
import { createGeminiCompletion } from './gemini-client';
import { register, unregister } from './session-registry';
import type { Segment, ProgressEvent } from './types';
import type { Scene } from '@/lib/lesson/types';
import {
  DEFAULT_LANGUAGE,
  buildStorytellerSystemMessage,
  personaForLanguage,
  STORYTELLER_VOICE_ID,
  STT_LANGUAGE,
  STT_MODEL,
  type DetectedLanguage,
} from '@/lib/language-config';

export interface OrchestratorConfig {
  agora_app_id: string;
  agora_app_certificate: string;
  /** Optional UID for the agent in the channel. Defaults to "1". */
  agent_uid?: string;
  /** Optional UID for the client. Defaults to "1000". */
  client_uid?: string;
  /** Persona / system prompt fed to the agent's LLM. */
  persona_prompt?: string;
  /** Opening greeting before the first segment. Defaults to empty. */
  greeting?: string;
  /**
   * The listener's detected language. Drives TTS voice / STT language /
   * persona selection. Falls back to English when absent so legacy callers
   * (and the qa-bench harnesses that don't run the detector) keep working.
   * Set by composeLessonAsync's detection and threaded via lesson/start.
   */
  language?: DetectedLanguage;
}

export interface RunTutorArgs {
  input_text: string;
  config: OrchestratorConfig;
  narration?: RunNarrationOptions;
}

export interface RunTutorHandle {
  session_id: string;
  channel: string;
  agent_id: string;
  rtc_token: string;
  rtm_token: string;
  client_uid: string;
  progress: ProgressState;
  /** Call AFTER subscribing to progress events. Resolves when narration finishes (or rejects on error). */
  startNarration: () => Promise<void>;
  /** Stop the session early. Safe to call even after narration finishes. */
  stop: () => Promise<void>;
  /** Called by /api/tutor/qa-ended when the browser detects the user's Q&A digression has ended. */
  handleQaEnded: (args: { qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }> }) => Promise<void>;
}

// Per-language base personas live in lib/language-config.ts (ENGLISH_PERSONA
// + PERSONA_BY_LANG). The agent's persona is resolved per-session in
// buildAgent() via personaForLanguage(lang). The qa-bench's extract-baseline
// script reads ENGLISH_PERSONA directly from lib/language-config.ts.

// Empty greeting on purpose — the narrator pushes scene 1 immediately, and
// any Agora-side greeting just adds an out-of-character preface ("Got it,
// let me read this through for you…") that breaks the storybook illusion.
const DEFAULT_GREETING = ``;

const PHASE3_FILLER: FillerWordsConfig = {
  enable: true,
  trigger: {
    mode: 'fixed_time',
    fixed_time_config: { response_wait_ms: 800 },
  },
  content: {
    mode: 'static',
    static_config: {
      phrases: ['Hmm.', 'Let me see.', 'One sec.'],
      selection_rule: 'shuffle',
    },
  },
};

const PHASE3_TURN: TurnDetectionConfig = {
  config: {
    start_of_speech: { mode: 'vad' },
    end_of_speech: { mode: 'semantic' },
  },
};

const PHASE3_ADVANCED: AdvancedFeatures = { enable_rtm: true };

const PHASE3_PARAMS: SessionParams = {
  data_channel: 'rtm',
  enable_metrics: true,
  enable_error_message: true,
};

function buildAgent(config: OrchestratorConfig, name: string): Agent {
  // Persona follows the detected language (L3). Voice + STT are deliberately
  // language-INDEPENDENT right now: one MiniMax voice for everything (it
  // speaks all our languages), and English-only STT as a "先凑合" stop-gap.
  // See lib/language-config.ts for the rationale on each.
  // Persona precedence: explicit config.persona_prompt (used by tests + the
  // B2 storybook-injection in startTutorSessionFromScenes) overrides the
  // language-mapped default.
  const lang = config.language ?? DEFAULT_LANGUAGE;
  const persona = config.persona_prompt ?? personaForLanguage(lang);

  return new Agent({
    name,
    instructions: persona,
    greeting: config.greeting ?? DEFAULT_GREETING,
  })
    // English-only STT for all languages — see STT_LANGUAGE rationale.
    .withStt(new DeepgramSTT({ model: STT_MODEL, language: STT_LANGUAGE }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: STORYTELLER_VOICE_ID,
      }),
    )
    // Phase 3 config via typed builders (Task 0 verified)
    .withFillerWords(PHASE3_FILLER)
    .withTurnDetection(PHASE3_TURN)
    .withAdvancedFeatures(PHASE3_ADVANCED)
    .withParameters(PHASE3_PARAMS);
}

/**
 * Generate the client-side RTC + RTM token for the browser to join the channel.
 * Uses RtcTokenBuilder.buildTokenWithRtm so the same token grants both RTC
 * channel access and RTM login (per ConvoAI requirements).
 */
function mintClientToken(args: {
  app_id: string;
  app_cert: string;
  channel: string;
  uid: string;
  ttl_seconds?: number;
}): string {
  const ttl = args.ttl_seconds ?? 60 * 60; // 1h
  const expireAt = Math.floor(Date.now() / 1000) + ttl;
  return RtcTokenBuilder.buildTokenWithRtm(
    args.app_id,
    args.app_cert,
    args.channel,
    args.uid,
    RtcRole.PUBLISHER,
    expireAt,
    expireAt,
  );
}

/**
 * Shared core that turns a session_id + channel + Segment[] into a started
 * AgentSession with a wired-up RunTutorHandle. Both startTutorSession (text
 * input → splitter → segments) and startTutorSessionFromScenes (Scene[]
 * mapped directly to segments) funnel through here.
 */
async function buildTutorHandle(args: {
  session_id: string;
  channel: string;
  segments: Segment[];
  config: OrchestratorConfig;
  narration?: RunNarrationOptions;
}): Promise<RunTutorHandle> {
  const { session_id, channel, segments, config } = args;

  // UID convention: use realistic numeric-string UIDs that match the
  // production invite-agent route. Single-digit UIDs like "1" cause some
  // Agora paths to refuse to publish to the channel.
  const agentUid = config.agent_uid ?? '123456';
  const clientUid = config.client_uid ?? '100000';

  const client = new AgoraClient({
    area: Area.US,
    appId: config.agora_app_id,
    appCertificate: config.agora_app_certificate,
  });
  const agent = buildAgent(config, `${session_id}-agent`);

  const session: AgentSession = agent.createSession(client, {
    channel,
    agentUid,
    // Use ['*'] to subscribe to any remote — mirrors the working invite-agent
    // route's behaviour where the agent isn't picky about a single client uid.
    remoteUids: ['*'],
    idleTimeout: 120,
    expiresIn: ExpiresIn.minutes(20),
    debug: false,
  });

  const agent_id = await session.start();

  const progress = new ProgressState(session_id, segments);

  // Mint a token for the browser to join the same channel
  const client_token = mintClientToken({
    app_id: config.agora_app_id,
    app_cert: config.agora_app_certificate,
    channel,
    uid: clientUid,
  });

  // Note: DO NOT emit events here. The caller hasn't subscribed yet. Save the
  // session_started payload and let the caller fire it after subscribing.
  const sessionStartedEvent = {
    channel,
    agent_id,
    rtc_token: client_token,
    rtm_token: client_token, // buildTokenWithRtm = single token for both
    client_uid: clientUid,
  };

  let narrationPromise: Promise<void> | null = null;

  // Context-sync: after each segment is narrated, push "the story so far" into
  // the agent's LLM system context via session.update(). This is the robust
  // fix for the "what's the cat's name?" bug: the agent reliably has every
  // already-narrated fact in its system prompt (eviction-proof, unlike
  // maxHistory-bounded conversation turns), while NOT-yet-narrated scenes are
  // never included — so it can answer known facts without spoiling. We
  // deliberately do NOT inject the whole storybook (that leaked the ending —
  // see scripts/voice-qa-bench/run.ts). Fire-and-forget; failures are logged
  // and never break narration.
  const lang = config.language ?? DEFAULT_LANGUAGE;
  const basePersona = config.persona_prompt ?? personaForLanguage(lang);
  const syncContext = (narratedSoFar: Segment[]): void => {
    // ONE merged system message via the shared builder — NOT two. The bench
    // proved separate [persona, story] messages silently drop the persona (only
    // the last system message is honored), so the agent would compute off-topic
    // math, admit being an AI, and ramble. buildStorytellerSystemMessage is the
    // single source of truth shared with the bench, so the bench stays faithful
    // by construction. basePersona already honors config.persona_prompt.
    const merged = buildStorytellerSystemMessage(basePersona, narratedSoFar);
    void session
      .update({ llm: { system_messages: [{ role: 'system', content: merged }] } })
      .catch((err) =>
        console.warn('[orchestrator] context-sync session.update failed:', (err as Error).message),
      );
  };

  const startNarration = () => {
    if (narrationPromise) return narrationPromise;
    // Emit session_started now that the caller is presumably subscribed
    progress.emitSessionStarted(sessionStartedEvent);
    narrationPromise = (async () => {
      try {
        await runNarration(session, progress, {
          ...args.narration,
          onSegmentNarrated: syncContext,
        });
      } finally {
        try {
          await session.stop();
        } catch (err) {
          console.warn(
            '[orchestrator] session.stop() failed:',
            (err as Error).message,
          );
        }
      }
    })();
    return narrationPromise;
  };

  const stop = async () => {
    try { await session.stop(); } catch {}
    unregister(session_id);
    // Tear down the debug logger's listener + globalThis state for this session
    // (this is the common sink for all routes' teardown — tutor/start &
    // lesson/start finally blocks and the tutor/stop route all call stop()).
    closeSessionLogger(session_id);
  };

  const handleQaEnded: RunTutorHandle['handleQaEnded'] = async ({ qa_history }) => {
    // Server only learns the user has been having a Q&A digression when this
    // POST arrives — the browser is the one watching RTM agent_state for the
    // barge-in. If we're still in MAIN when the ping lands, trust the browser
    // and enter BRANCH now (pinning paused_segment_id to whatever segment the
    // narrator is currently inside). DONE / ERROR / IDLE remain rejected.
    // Capture how much of the current segment's audio has played BEFORE we
    // mutate any state — this is the listener's real "% heard" of the scene
    // they interrupted, which the resume planner uses to bias restart vs skip.
    const pausedScenePct = progress.currentSegmentProgress();

    let snap = progress.snapshot();
    if (snap.outer_state === 'MAIN') {
      progress.enterBranch();
      snap = progress.snapshot();
    } else if (snap.outer_state !== 'BRANCH') {
      progress.emitError(`handleQaEnded called from outer_state=${snap.outer_state}`);
      return;
    }
    for (const turn of qa_history) {
      progress.recordQaTurn(turn.role, turn.text);
    }

    // Resolve the paused scene + what would have come next from the
    // ProgressState snapshot. paused_segment_id is now accurate (narrator's
    // per-segment sleep means current_segment_id reflects the segment the
    // listener actually heard at interrupt time).
    const allSegs = progress.segments;
    const pausedId = snap.branch_line.paused_segment_id;
    const pausedIdx = pausedId ? allSegs.findIndex((s) => s.id === pausedId) : -1;
    const pausedSeg = pausedIdx >= 0 ? allSegs[pausedIdx] : allSegs[0];
    const actualPausedIdx = pausedIdx >= 0 ? pausedIdx : 0;
    const nextSegs = allSegs.slice(actualPausedIdx + 1, actualPausedIdx + 3);
    // Climax-leak fix (experiment 2026-05-29-climax-leak): when the story's FINAL
    // scene is in the planner's lookahead, hand it only the first sentence. The
    // planner needs enough to transition toward the ending, but giving it the full
    // resolution text makes it intermittently leak the outcome into a climax resume
    // (the C7 failure). Redacting the ending closed C7 0/3 → 3/3 with no regression.
    const lastSegIdx = allSegs.length - 1;
    const redactEndingText = (s: Segment): string =>
      allSegs.findIndex((x) => x.id === s.id) === lastSegIdx
        ? (s.text.split(/(?<=[.!?])\s/)[0] ?? s.text)
        : s.text;

    const llm = createGeminiCompletion({
      apiKey: process.env.GOOGLE_API_KEY ?? '',
      model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
    });

    const { plan, source: plannerSource } = await planResume(
      {
        story_title: '',
        paused_scene: { id: pausedSeg.id, text: pausedSeg.text },
        paused_scene_progress: pausedScenePct,
        next_scenes: nextSegs.map((s) => ({ id: s.id, text: redactEndingText(s) })),
        qa_history: progress.snapshot().branch_line.qa_history.map((t) => ({
          role: t.role,
          text: t.text,
        })),
      },
      { llm, budget_ms: 4500 },
    );

    // 1. Bridge plays immediately via INTERRUPT — clears whatever Agora has
    //    buffered (the tail of the paused segment audio + any APPENDs we
    //    queued before BRANCH fired).
    progress.emit('event', {
      type: 'bridge_started',
      text: plan.bridge_text,
    } satisfies ProgressEvent);
    await session.say(plan.bridge_text, { priority: 'INTERRUPT' });

    // 2. Apply the planner's replacement_segments into ProgressState so the
    //    narrator loop, when it wakes from waitForMain(), picks up the
    //    rewritten texts at the right pointer position.
    const targetIds = plan.replacement_segments.map((r) => r.id);
    const replacementSegs: Segment[] = plan.replacement_segments.map((r) => {
      const orig = allSegs.find((s) => s.id === r.id);
      return {
        id: r.id,
        range: { start: 0, end: r.text.length },
        text: r.text,
        approx_duration_ms:
          Math.max(700, Math.round((r.text.length / 17) * 1000)) + 150,
        category: orig?.category ?? 'exposition',
        elicitation_node: false,
      };
    });
    progress.replaceSegments(targetIds, replacementSegs);

    // 3. Set the narrator's pull pointer to the first replacement segment so
    //    the next iteration of its loop re-speaks that scene (with the
    //    rewritten text).
    const firstReplacementIdx = allSegs.findIndex(
      (s) => s.id === plan.replacement_segments[0].id,
    );
    if (firstReplacementIdx >= 0) {
      progress.setNextIndex(firstReplacementIdx);
    }

    // 4. Tell the UI which scene to be on. For restart/continue strategies
    //    the UI flips back to the paused page; for skip it advances.
    const reason =
      plan.resume_strategy === 'restart'
        ? 'planner_restart'
        : plan.resume_strategy === 'continue'
          ? 'planner_continue'
          : 'planner_skip';
    progress.emit('event', {
      type: 'active_scene_changed',
      scene_id: plan.active_scene_id,
      reason,
    } satisfies ProgressEvent);

    // 5. Exit BRANCH — narrator's waitForMain() resolves and the loop pulls
    //    the (now-rewritten) segment at the (now-rewound) pointer.
    progress.exitBranch();
    progress.emit('event', { type: 'bridge_completed' } satisfies ProgressEvent);
    console.log(
      `[orchestrator] resume plan: strategy=${plan.resume_strategy} source=${plannerSource} segs=${targetIds.join(',')}`,
    );
  };

  const handle: RunTutorHandle = {
    session_id,
    channel,
    agent_id,
    rtc_token: client_token,
    rtm_token: client_token,
    client_uid: clientUid,
    progress,
    startNarration,
    stop,
    handleQaEnded,
  };

  register(handle);
  // Per-session debug log (console always; local file when available). Attached
  // here so BOTH startTutorSession and startTutorSessionFromScenes are covered.
  attachSessionLogger(handle);
  return handle;
}

export async function startTutorSession(args: RunTutorArgs): Promise<RunTutorHandle> {
  const segments: Segment[] = splitToSegments(args.input_text, { idPrefix: 's' });
  if (segments.length === 0) {
    throw new Error('input_text produced 0 segments after splitting');
  }
  const session_id = `tutor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const channel = session_id;
  return buildTutorHandle({
    session_id,
    channel,
    segments,
    config: args.config,
    narration: args.narration,
  });
}

/**
 * Like startTutorSession but accepts pre-composed Scenes instead of raw
 * input_text. Each Scene becomes a single Segment (no splitter pass). Scene
 * id becomes Segment id.
 *
 * The returned handle is identical in shape to startTutorSession's — same
 * SSE event stream, same handleQaEnded, same stop, etc. Lesson SSE routes
 * use this entry point; Phase 1 /api/tutor/start keeps using
 * startTutorSession.
 */
export async function startTutorSessionFromScenes(args: {
  scenes: Scene[];
  config: OrchestratorConfig;
  narration?: RunNarrationOptions;
}): Promise<RunTutorHandle> {
  if (args.scenes.length === 0) {
    throw new Error('scenes array is empty');
  }
  const segments: Segment[] = args.scenes.map((scene) => ({
    id: scene.id,
    range: { start: 0, end: scene.narration_text.length },
    text: scene.narration_text,
    // Heuristic: ~17 chars/sec English TTS + 150ms padding, floor 700ms.
    approx_duration_ms:
      Math.max(700, Math.round((scene.narration_text.length / 17) * 1000)) + 150,
    category: 'exposition',
    elicitation_node: false,
  }));
  const session_id = `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const channel = session_id;

  // NOTE on the "cat's name" Q&A context (the 2026-05-30 Barnaby bug):
  // We deliberately do NOT inject the storybook into the persona here.
  //
  //   - The getHistory probe (scripts/probes/say-context-probe.ts) proved that
  //     the narrator's session.say() text IS stored in the agent's
  //     conversation history (role:assistant), IN ORDER, WITHOUT the
  //     not-yet-narrated scenes. So the agent already has "what's been read so
  //     far" as natural context — injection adds nothing for availability.
  //
  //   - The voice-qa-bench (scripts/voice-qa-bench/run.ts) proved that the
  //     OPPOSITE (static-all-scenes injection) is actively HARMFUL: with the
  //     whole book — including the ending — in the system prompt, the agent
  //     LEAKS the ending (spoiler) 2/2 trials, while the natural narrated-so-far
  //     context answers factual questions correctly AND never spoils 0/2.
  //
  // So the correct context mechanism is the one Agora already gives us for
  // free: say() → conversation history. If a future need arises to FORCE
  // narrated-so-far into the system prompt (e.g. if maxHistory eviction bites
  // on long stories), do it DYNAMICALLY via session.update() per segment —
  // never statically inject future scenes. personaWithStorybook() is kept in
  // lib/language-config.ts for that dynamic path; it is intentionally unwired.
  return buildTutorHandle({
    session_id,
    channel,
    segments,
    config: args.config,
    narration: args.narration,
  });
}

export { splitToSegments } from './splitter';
export { ProgressState } from './progress-state';
export type {
  Segment,
  ProgressEvent,
  ProgressSnapshot,
  OrchestratorOuterState,
} from './types';

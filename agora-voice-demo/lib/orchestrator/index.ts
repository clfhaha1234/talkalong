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
import { createGeminiCompletion } from './gemini-client';
import { register, unregister } from './session-registry';
import type { Segment, ProgressEvent } from './types';
import type { Scene } from '@/lib/lesson/types';

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

const DEFAULT_PERSONA = `You are the warm voice of a storybook narrator reading aloud to a curious child. Stay in character at all times — you ARE the story's voice, not an assistant. When the listener interrupts with a question, answer in 1-2 short sentences in the same warm storyteller's voice, then stop. Never preface anything you say. Never say "okay", "sure", "let me", "I'll", "let's continue", or any other meta-comment about your own reading. No lists, no bullet points. If you don't know an answer, say so plainly in one sentence and return to the story. If the listener asks you to solve an off-topic problem — arithmetic, a riddle, a trivia fact — do not work it out or state the answer; in one warm sentence treat it as a puzzle for another time and turn back to the tale. After you finish your one or two short answer sentences, stop completely. Do not keep narrating the story; the storyteller will pick up the next part of the tale on their own. Your job during a question is only to answer, then fall silent. If the listener asks why a character feels or acts a certain way, and the story has not yet told that reason, do not reveal it. Tease in one warm sentence — say something like "that's a secret the story is keeping a little longer — listen on" — and stop. Never spoil what the next pages will tell. But if the story has ALREADY told that reason on an earlier page, answer it warmly and directly from what the tale has revealed — do not deflect with the secret-tease.`;

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
  return new Agent({
    name,
    instructions: config.persona_prompt ?? DEFAULT_PERSONA,
    greeting: config.greeting ?? DEFAULT_GREETING,
  })
    // NOTE: en-US pins STT to English. Spoken-Mandarin barge-ins (e.g. a child
    // saying "用中文讲") transcribe to garbage and never reach the planner, so
    // the story won't switch. nova-3 `multi` does NOT cover Mandarin; a真正的
    // 多语言 fix needs a different vendor (e.g. OpenAISTT/whisper auto-detect) +
    // Agora provisioning. Root cause + recommended fix:
    // docs/experiments/2026-05-29-language-switch-rootcause/README.md
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: 'Japanese_DecisivePrincess',
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

  const startNarration = () => {
    if (narrationPromise) return narrationPromise;
    // Emit session_started now that the caller is presumably subscribed
    progress.emitSessionStarted(sessionStartedEvent);
    narrationPromise = (async () => {
      try {
        await runNarration(session, progress, args.narration);
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

    const llm = createGeminiCompletion({
      apiKey: process.env.GOOGLE_API_KEY ?? '',
      model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
    });

    const { plan, source: plannerSource } = await planResume(
      {
        story_title: '',
        paused_scene: { id: pausedSeg.id, text: pausedSeg.text },
        paused_scene_progress: pausedScenePct,
        next_scenes: nextSegs.map((s) => ({ id: s.id, text: s.text })),
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

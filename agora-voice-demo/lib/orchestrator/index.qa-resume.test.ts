// Integration test for the Q&A → resume wiring inside the orchestrator.
//
// This is the "e2e of the path the user hit": a listener interrupts mid-scene
// and (per the resume plan) the story should switch to Chinese. A real voice
// barge-in can't run in CI (it needs live Agora STT/TTS + a microphone), so we
// drive the REAL handleQaEnded with a mocked AgentSession that records every
// session.say() call, and a mocked planner that returns a deterministic Chinese
// plan. That isolates the orchestration plumbing — bridge playback, segment
// replacement, pointer rewind, and the UI event stream — from the planner's LLM
// quality, which the qa-bench eval covers separately.

import { describe, it, expect, vi } from 'vitest';
import type { ProgressEvent } from './types';

const sayCalls: Array<{ text: string; opts: { priority?: string; interruptable?: boolean } }> = [];

vi.mock('agora-agent-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('agora-agent-server-sdk')>();
  return {
    ...orig,
    AgoraClient: class {
      constructor(_o: unknown) {}
    },
    Agent: class {
      withStt() { return this; }
      withLlm() { return this; }
      withTts() { return this; }
      withFillerWords() { return this; }
      withTurnDetection() { return this; }
      withAdvancedFeatures() { return this; }
      withParameters() { return this; }
      createSession() {
        return {
          start: async () => 'fake-agent-id',
          stop: async () => {},
          say: async (text: string, opts: { priority?: string; interruptable?: boolean }) => {
            sayCalls.push({ text, opts });
          },
          interrupt: async () => {},
          update: async () => {},
          getHistory: async () => ({ contents: [] }),
          getTurns: async () => ({ turns: [] }),
          raw: {},
          status: 'running' as const,
          id: 'fake-agent-id',
          appId: 'app',
        };
      }
    },
  };
});

// Deterministic Chinese resume plan. Tests the WIRING, not planner LLM output.
vi.mock('./resume-planner', () => ({
  planResume: vi.fn(async (input: { paused_scene: { id: string } }) => ({
    plan: {
      bridge_text: '古树的低吟仿佛在等你，我们就用中文接着讲下去。',
      resume_strategy: 'continue',
      replacement_segments: [
        { id: input.paused_scene.id, text: '莉娜屏住呼吸，慢慢靠近那棵会哼唱的古树，心里既好奇又有点害怕。' },
      ],
      active_scene_id: input.paused_scene.id,
    },
    source: 'llm',
    latency_ms: 5,
  })),
}));

import { startTutorSessionFromScenes } from './index';
import { planResume } from './resume-planner';
import type { Scene } from '@/lib/lesson/types';

const scenes: Scene[] = [
  {
    id: 's1',
    chapter: 'Chapter One',
    sceneNum: 'Scene I',
    headline: ['The', 'Tree'],
    narration_text: 'Lina crept toward the humming tree, holding her breath in the cold.',
    image_prompt: 'a girl near a glowing tree',
  },
  {
    id: 's2',
    chapter: 'Chapter Two',
    sceneNum: 'Scene II',
    headline: ['The', 'Fox'],
    narration_text: 'A grey old fox in a green vest watched her from the top step.',
    image_prompt: 'a grey fox in a vest',
  },
];

describe('handleQaEnded — Chinese language-switch resume wiring', () => {
  it('plays a Chinese bridge via INTERRUPT and rewrites the paused segment to Chinese', async () => {
    sayCalls.length = 0;
    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });

    const events: ProgressEvent[] = [];
    handle.progress.subscribe((e) => events.push(e));

    // Simulate the narrator being mid-way through scene 1 when the user barges in.
    handle.progress.enterMain();
    handle.progress.startSegment(handle.progress.segments[0]);

    await handle.handleQaEnded({
      qa_history: [
        { role: 'user', text: '能不能接下来用中文讲故事？', ts: 1 },
        { role: 'agent', text: '当然可以，我们就用中文继续讲。', ts: 2 },
      ],
    });

    // 1. The bridge was spoken via INTERRUPT (clears buffered English audio) in Chinese.
    const bridgeSay = sayCalls.find((s) => /[一-鿿]/.test(s.text));
    expect(bridgeSay, 'a Chinese bridge should have been spoken').toBeTruthy();
    expect(bridgeSay!.opts.priority).toBe('INTERRUPT');
    // The bridge MUST be interruptable too — the listener has to be able to
    // barge in on the resume bridge itself, not be forced to sit through it.
    // (narrator.test guards the narration segments; this guards the bridge.)
    expect(bridgeSay!.opts.interruptable).toBe(true);

    // 2. A bridge_started event carried the Chinese bridge text to the UI.
    const bridgeEvt = events.find((e) => e.type === 'bridge_started') as
      | (ProgressEvent & { text?: string })
      | undefined;
    expect(bridgeEvt?.text).toMatch(/[一-鿿]/);

    // 3. The paused segment's text was replaced with Chinese in ProgressState,
    //    so when the narrator resumes it re-speaks the scene in Chinese.
    const s1 = handle.progress.segments.find((s) => s.id === 's1');
    expect(s1?.text).toMatch(/[一-鿿]/);
    expect(s1?.text).not.toMatch(/Lina crept/);

    // 4. The UI was told which scene to show (continue → stays on the paused page).
    const active = events.find((e) => e.type === 'active_scene_changed') as
      | (ProgressEvent & { scene_id?: string; reason?: string })
      | undefined;
    expect(active?.scene_id).toBe('s1');
    expect(active?.reason).toBe('planner_continue');

    // 5. BRANCH was exited cleanly and the bridge completion was announced.
    expect(events.some((e) => e.type === 'bridge_completed')).toBe(true);
    expect(handle.progress.outerState()).toBe('MAIN');
  });

  it('rejects a qa-ended ping that arrives outside MAIN/BRANCH (e.g. IDLE)', async () => {
    sayCalls.length = 0;
    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    const events: ProgressEvent[] = [];
    handle.progress.subscribe((e) => events.push(e));

    // Never entered MAIN — outer state is still IDLE.
    await handle.handleQaEnded({ qa_history: [{ role: 'user', text: 'hi', ts: 1 }] });

    // Nothing should have been spoken; an error event should be emitted instead.
    expect(sayCalls.length).toBe(0);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

// Scene-VIDEO alignment on resume: the page the UI shows (active_scene_changed →
// activeSceneIndex → <video src=scenes[i].video_url>) MUST match the page the
// narrator resumes on (progress.nextSegment()). If they diverge, the storybook
// would play scene N's video while the agent narrates scene M — the exact
// "wrong page's video after an interrupt" bug. This verifies the orchestrator
// keeps them in lockstep across all three resume strategies, including when the
// planner rewrites the resumed scene's text (content change) — the video page
// selection follows the active scene id, not the stale narration.
describe('handleQaEnded — scene-video page selection stays aligned with narration', () => {
  // paused on s1; next scene is s2.
  const cases = [
    { strategy: 'continue', active: 's1', firstSeg: 's1', desc: 'continue → stay on paused page' },
    { strategy: 'restart', active: 's1', firstSeg: 's1', desc: 'restart → rewind to paused page (rewritten text)' },
    { strategy: 'skip', active: 's2', firstSeg: 's2', desc: 'skip → advance to next page' },
  ] as const;

  for (const c of cases) {
    it(`${c.desc}: UI active scene === narrator next segment === ${c.active}`, async () => {
      sayCalls.length = 0;
      vi.mocked(planResume).mockResolvedValueOnce({
        plan: {
          bridge_text: 'A short warm bridge back into the tale, friend — listen on now.',
          resume_strategy: c.strategy,
          // first replacement targets the resumed page; its rewritten text is what
          // the narrator will speak — the scene's VIDEO is keyed to the scene id,
          // not this text, so a content rewrite must not desync the page shown.
          replacement_segments: [{ id: c.firstSeg, text: 'Rewritten narration for the resumed scene, woven with the Q&A.' }],
          active_scene_id: c.active,
        },
        source: 'llm',
        latency_ms: 5,
      });

      const handle = await startTutorSessionFromScenes({
        scenes,
        config: { agora_app_id: 'a', agora_app_certificate: 'b' },
      });
      const events: ProgressEvent[] = [];
      handle.progress.subscribe((e) => events.push(e));
      handle.progress.enterMain();
      handle.progress.startSegment(handle.progress.segments[0]); // paused on s1

      await handle.handleQaEnded({
        qa_history: [{ role: 'user', text: 'a question', ts: 1 }],
      });

      // (a) The UI is told to show the resumed scene's page (drives the <video>).
      const active = events.find((e) => e.type === 'active_scene_changed') as
        | (ProgressEvent & { scene_id?: string })
        | undefined;
      expect(active?.scene_id).toBe(c.active);

      // (b) The narrator's next pull is the SAME page — so the scene VIDEO the UI
      //     plays matches the scene the agent is about to narrate (no desync).
      expect(handle.progress.nextSegment()?.id).toBe(c.active);

      // (c) Back on the main line, ready to narrate the resumed page.
      expect(handle.progress.outerState()).toBe('MAIN');
    });
  }
});

describe('handleQaEnded — no-question guard (false barge-in / narration tail)', () => {
  // Regression for the 2026-05-31 bug: a branch with no REAL user question still
  // ran the planner and spoke a chatty bridge ("Got it — now, where were we?")
  // at a scene boundary with nothing behind it. Now it must resume silently.
  it('empty qa_history → no planner, no bridge, clean resume to MAIN', async () => {
    sayCalls.length = 0;
    (planResume as unknown as { mockClear: () => void }).mockClear();
    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    const events: ProgressEvent[] = [];
    handle.progress.subscribe((e) => events.push(e));
    handle.progress.enterMain();
    handle.progress.startSegment(handle.progress.segments[0]);

    await handle.handleQaEnded({ qa_history: [] });

    expect(planResume).not.toHaveBeenCalled();
    expect(sayCalls.length, 'no bridge should be spoken').toBe(0);
    expect(events.some((e) => e.type === 'bridge_started')).toBe(false);
    expect(events.some((e) => e.type === 'bridge_completed')).toBe(true);
    expect(handle.progress.outerState()).toBe('MAIN');
  });

  it('agent-only qa_history (no real question) → same clean resume, no bridge', async () => {
    sayCalls.length = 0;
    (planResume as unknown as { mockClear: () => void }).mockClear();
    const handle = await startTutorSessionFromScenes({
      scenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    handle.progress.enterMain();
    handle.progress.startSegment(handle.progress.segments[0]);

    await handle.handleQaEnded({
      qa_history: [{ role: 'agent', text: 'Lina crept toward the tree.', ts: 1 }],
    });

    expect(planResume).not.toHaveBeenCalled();
    expect(sayCalls.length).toBe(0);
    expect(handle.progress.outerState()).toBe('MAIN');
  });
});

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

const sayCalls: Array<{ text: string; opts: { priority?: string } }> = [];

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
          say: async (text: string, opts: { priority?: string }) => {
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

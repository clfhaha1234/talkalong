import { describe, it, expect, vi } from 'vitest';
import { startTutorSessionFromScenes } from './index';
import type { Scene } from '@/lib/lesson/types';

// Stub AgoraClient + Agent + AgentSession so no network is hit.
vi.mock('agora-agent-server-sdk', async (importOriginal) => {
  const orig = await importOriginal<typeof import('agora-agent-server-sdk')>();
  return {
    ...orig,
    AgoraClient: class {
      appId: string;
      constructor(o: { appId: string }) {
        this.appId = o.appId;
      }
    },
    Agent: class {
      withStt() {
        return this;
      }
      withLlm() {
        return this;
      }
      withTts() {
        return this;
      }
      withFillerWords() {
        return this;
      }
      withTurnDetection() {
        return this;
      }
      withAdvancedFeatures() {
        return this;
      }
      withParameters() {
        return this;
      }
      createSession() {
        return {
          start: async () => 'fake-agent-id',
          stop: async () => {},
          say: async () => {},
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

const sampleScenes: Scene[] = [
  {
    id: 's1',
    chapter: 'Chapter One',
    sceneNum: 'Scene I',
    headline: ['A', 'B'],
    narration_text: 'Hello world.',
    image_prompt: 'foo',
  },
  {
    id: 's2',
    chapter: 'Chapter Two',
    sceneNum: 'Scene II',
    headline: ['C', 'D'],
    narration_text: 'Second scene.',
    image_prompt: 'bar',
  },
];

describe('startTutorSessionFromScenes', () => {
  it('returns a handle whose progress.segments mirror scenes', async () => {
    const handle = await startTutorSessionFromScenes({
      scenes: sampleScenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    expect(handle.progress.segments.length).toBe(2);
    expect(handle.progress.segments[0].id).toBe('s1');
    expect(handle.progress.segments[0].text).toBe('Hello world.');
    expect(handle.progress.segments[1].id).toBe('s2');
  });

  it('session_id uses lesson- prefix', async () => {
    const handle = await startTutorSessionFromScenes({
      scenes: sampleScenes,
      config: { agora_app_id: 'a', agora_app_certificate: 'b' },
    });
    expect(handle.session_id).toMatch(/^lesson-/);
  });

  it('throws on empty scenes', async () => {
    await expect(
      startTutorSessionFromScenes({
        scenes: [],
        config: { agora_app_id: 'a', agora_app_certificate: 'b' },
      }),
    ).rejects.toThrow('scenes array is empty');
  });
});

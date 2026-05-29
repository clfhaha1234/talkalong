import { describe, it, expect, vi } from 'vitest';
import { planResume, type ResumePlanInput } from './resume-planner';

const baseInput: ResumePlanInput = {
  story_title: 'The Boy Who Chased the Light',
  paused_scene: {
    id: 's3',
    text: 'Albert sat on the hill, watching the sun set behind the windmills. He wondered what light really was — could it be tugged like a kite string, or did it travel free as a wish?',
  },
  paused_scene_progress: 0.3,
  next_scenes: [
    { id: 's4', text: 'In Bern, years later, Albert was a clerk by day and a dreamer by night.' },
    { id: 's5', text: 'And then one summer the answer came to him on a tram ride home.' },
  ],
  qa_history: [
    { role: 'user', text: 'Why is light fast?' },
    { role: 'agent', text: 'Because nothing in our world pushes back against it.' },
  ],
};

describe('planResume — LLM happy path', () => {
  it('accepts a well-formed JSON plan with restart strategy', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        bridge_text:
          'Light is quick, yes — quicker than anything Albert had ever chased. Let me settle us back beside him on that windy hill.',
        resume_strategy: 'restart',
        replacement_segments: [
          {
            id: 's3',
            text: 'Albert was perched on the green hillside, watching the sun lean down behind the slow turning windmills. He kept turning a strange question in his head — could light be caught, or was it free as the wind itself?',
          },
        ],
        active_scene_id: 's3',
      }),
    );
    const { plan, source } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(source).toBe('llm');
    expect(plan.resume_strategy).toBe('restart');
    expect(plan.replacement_segments[0].id).toBe('s3');
    expect(plan.active_scene_id).toBe('s3');
  });

  it('accepts skip strategy when Q&A made paused scene redundant', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        bridge_text:
          "Right, so light won't be caught — and Albert won't stop trying. Years pass, and the boy on the hill becomes a young man in a city.",
        resume_strategy: 'skip',
        replacement_segments: [
          {
            id: 's4',
            text: 'In Bern, far from any windmill, Albert sat at a wooden desk by day and dreamed by lamp light each evening.',
          },
        ],
        active_scene_id: 's4',
      }),
    );
    const { plan } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(plan.resume_strategy).toBe('skip');
    expect(plan.replacement_segments[0].id).toBe('s4');
  });

  it('strips markdown fences before parsing', async () => {
    const llm = vi.fn(async () =>
      '```json\n' +
        JSON.stringify({
          bridge_text: 'Coming back to where we were on that hillside with Albert.',
          resume_strategy: 'continue',
          replacement_segments: [
            {
              id: 's3',
              text: 'The sun dipped lower, and Albert kept his eyes on it as if it might give up its secret.',
            },
          ],
          active_scene_id: 's3',
        }) +
        '\n```',
    );
    const { plan } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(plan.resume_strategy).toBe('continue');
  });
});

describe('planResume — validation + repair', () => {
  it('drops replacement segments with unknown ids', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        bridge_text: 'Coming back to where we were on that hillside with Albert.',
        resume_strategy: 'restart',
        replacement_segments: [
          { id: 's3', text: 'Albert was perched on the green hillside watching the sun set lazily behind the windmills.' },
          { id: 's999', text: 'Bogus id that should be filtered out completely from the plan.' },
        ],
        active_scene_id: 's3',
      }),
    );
    const { plan } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(plan.replacement_segments.map((r) => r.id)).toEqual(['s3']);
  });

  it('downgrades skip-strategy that incorrectly starts with paused id to continue', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        bridge_text: 'Coming back to where we were on that hillside with Albert.',
        resume_strategy: 'skip',
        replacement_segments: [
          {
            id: 's3',
            text: 'Albert kept staring at the sun, and the answer kept eluding him for now.',
          },
        ],
        active_scene_id: 's3',
      }),
    );
    const { plan } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(plan.resume_strategy).toBe('continue');
  });

  it('upgrades restart strategy that incorrectly starts with a next-scene id to skip', async () => {
    const llm = vi.fn(async () =>
      JSON.stringify({
        bridge_text: 'Coming back to where we were with Albert chasing that beam of light.',
        resume_strategy: 'restart',
        replacement_segments: [
          {
            id: 's4',
            text: 'Years later in Bern, Albert was a quiet clerk by day and a dreamer by night.',
          },
        ],
        active_scene_id: 's4',
      }),
    );
    const { plan } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(plan.resume_strategy).toBe('skip');
  });
});

describe('planResume — fallback', () => {
  it('falls back to deterministic plan when LLM throws', async () => {
    const llm = vi.fn(async () => {
      throw new Error('boom');
    });
    const { plan, source } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(source).toBe('fallback');
    expect(plan.bridge_text.length).toBeGreaterThan(10);
    // 30% spoken → restart
    expect(plan.resume_strategy).toBe('restart');
    expect(plan.replacement_segments[0].id).toBe('s3');
  });

  it('fallback picks skip strategy when paused_scene was >70% spoken', async () => {
    const llm = vi.fn(async () => 'not json at all');
    const { plan } = await planResume(
      { ...baseInput, paused_scene_progress: 0.85 },
      { llm, budget_ms: 5000 },
    );
    expect(plan.resume_strategy).toBe('skip');
    expect(plan.replacement_segments[0].id).toBe('s4');
  });

  it('falls back when LLM output is malformed JSON', async () => {
    const llm = vi.fn(async () => '{ bridge_text: "no quotes around keys"');
    const { source } = await planResume(baseInput, { llm, budget_ms: 5000 });
    expect(source).toBe('fallback');
  });

  it('falls back when LLM exceeds budget', async () => {
    const llm = vi.fn(() => new Promise<string>(() => {})); // never resolves
    const t0 = Date.now();
    const { source } = await planResume(baseInput, { llm, budget_ms: 50 });
    const elapsed = Date.now() - t0;
    expect(source).toBe('fallback');
    expect(elapsed).toBeLessThan(500);
  });
});

//
// Rewrite the next 1-2 segments after a Q&A digression, integrating awareness
// of what the user asked. LLM watchdog falls back to the original segments on
// timeout, malformed response, or error — the bridge already covered the
// transition, so a no-op rewrite is still safe.

import type { Segment } from './types';

export interface RescriptContext {
  originals: Segment[];
  qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
  depth_setting: 'simpler' | 'default' | 'deeper';
}

export interface RescriptOptions {
  llm: (prompt: string) => Promise<string>;
  budget_ms: number;
}

export interface RescriptResult {
  segments: Segment[];
  source: 'llm' | 'fallback';
  latency_ms: number;
}

const SYSTEM = `You rewrite 1-2 short narration segments to subtly integrate awareness of what the user just asked about. Rules:
- Preserve the core content and order of facts in each segment.
- Where natural, weave a single short clause referencing the user's question.
- Keep each segment's character count within ±20% of the original.
- Output JSON only: an array of objects { "id": "...", "text": "..." }, one per original segment.`;

function buildPrompt(ctx: RescriptContext): string {
  const lastUserQ = [...ctx.qa_history].reverse().find((t) => t.role === 'user')?.text ?? '';
  const lastAgentA = [...ctx.qa_history].reverse().find((t) => t.role === 'agent')?.text ?? '';
  const segmentsForPrompt = ctx.originals.map((s) => ({ id: s.id, text: s.text }));
  return `${SYSTEM}

Depth setting: ${ctx.depth_setting} (simpler = shorter words, more analogies; deeper = more nuance; default = no change).
User just asked: "${lastUserQ}"
You just answered: "${lastAgentA.slice(0, 200)}"
Original next segments (JSON): ${JSON.stringify(segmentsForPrompt)}

Output:`;
}

export async function rescriptSegments(
  ctx: RescriptContext,
  opts: RescriptOptions,
): Promise<RescriptResult> {
  const t0 = Date.now();
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('rescript_budget_exceeded')), opts.budget_ms),
  );
  try {
    const raw = await Promise.race([opts.llm(buildPrompt(ctx)), watchdog]);
    const parsed = JSON.parse(raw) as Array<{ id: string; text: string }>;
    if (!Array.isArray(parsed) || parsed.length !== ctx.originals.length) {
      throw new Error('rescript_shape_mismatch');
    }
    const newSegments: Segment[] = ctx.originals.map((orig) => {
      const found = parsed.find((p) => p.id === orig.id);
      if (!found || typeof found.text !== 'string' || found.text.length < 20) {
        throw new Error('rescript_missing_or_too_short_for_' + orig.id);
      }
      return {
        ...orig,
        text: found.text.trim(),
        approx_duration_ms: Math.max(700, Math.round((found.text.length / 17) * 1000)) + 150,
      };
    });
    return { segments: newSegments, source: 'llm', latency_ms: Date.now() - t0 };
  } catch {
    return { segments: ctx.originals, source: 'fallback', latency_ms: Date.now() - t0 };
  }
}

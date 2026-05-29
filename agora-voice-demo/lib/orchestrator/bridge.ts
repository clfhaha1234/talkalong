// lib/orchestrator/bridge.ts
//
// Generate the bridge-line utterance the agent speaks when transitioning
// from BRANCH back to MAIN. The LLM call is wrapped in a watchdog so a
// slow LLM cannot stall the resume. If the LLM is late or fails, we pick
// from the pre-written bridge-library.

import { pickBridge } from './bridge-library';

export interface BridgeContext {
  qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
  paused_segment_text: string;
  next_segment_text: string;
}

export type LlmFn = (prompt: string) => Promise<string>;

export interface BridgeOptions {
  llm: LlmFn;
  budget_ms: number;
}

export interface BridgeResult {
  text: string;
  source: 'llm' | 'fallback';
  latency_ms: number;
}

const SYSTEM = `You write 1-2 sentence bridge utterances for a voice tutor returning from a Q&A digression to the main lesson. Constraints:
- Total 60-150 characters.
- Reference what the user just asked about in one short phrase.
- Re-orient back to the paused content.
- Plain spoken English. No "great question!" preamble. No lists, no formatting.`;

function buildPrompt(ctx: BridgeContext): string {
  const lastUserQ = [...ctx.qa_history].reverse().find((t) => t.role === 'user')?.text ?? '';
  const lastAgentA = [...ctx.qa_history].reverse().find((t) => t.role === 'agent')?.text ?? '';
  return `${SYSTEM}

User just asked: "${lastUserQ}"
You just answered: "${lastAgentA.slice(0, 200)}"
We were in the middle of: "${ctx.paused_segment_text.slice(0, 200)}"
Next we will continue with: "${ctx.next_segment_text.slice(0, 200)}"

Write the bridge utterance:`;
}

export async function generateBridge(
  ctx: BridgeContext,
  opts: BridgeOptions,
): Promise<BridgeResult> {
  const t0 = Date.now();
  const watchdog = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('bridge_budget_exceeded')), opts.budget_ms),
  );
  try {
    const text = await Promise.race([opts.llm(buildPrompt(ctx)), watchdog]);
    if (!text || text.length < 30) throw new Error('bridge_too_short');
    return { text: text.trim(), source: 'llm', latency_ms: Date.now() - t0 };
  } catch {
    return { text: pickBridge(), source: 'fallback', latency_ms: Date.now() - t0 };
  }
}

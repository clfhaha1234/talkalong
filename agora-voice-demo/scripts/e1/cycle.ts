// One cycle = one (arm, row, cycle_index) measurement.
//
// Architecture: per cycle we only record LOCAL timestamps + the say() / interrupt()
// REST calls + (optionally) update() the system prompt. We do NOT poll getTurns()
// mid-session — that endpoint returns 404 TaskNotFound until the session stops.
//
// The runner is responsible for stopping the session, fetching getTurns() once,
// and matching turns to cycle records by chronological order.

import type { AgentSession, AgentConfigUpdate } from 'agora-agent-server-sdk';

export type DriveStrategy = 'speak-api' | 'update-then-speak' | 'llm-via-prompt';

export type CycleLocalRecord = {
  arm: string;
  row_id: string;
  cycle: number;
  segment_text: string;
  /** Local clock when we called session.say() (or 0 for baseline). */
  say_call_ts: number;
  /** Local clock when we called session.interrupt(). null if not called. */
  interrupt_call_ts: number | null;
  /** Errors thrown by drive calls. */
  errors: string[];
  /** Drive strategy used. */
  drive_strategy: DriveStrategy;
};

export type RunOneCycleArgs = {
  session: AgentSession;
  arm: string;
  driveStrategy: DriveStrategy;
  row: { row_id: string; text: string; length?: string; category?: string };
  cycleIndex: number;
  /** ms into the segment audio before firing interrupt. */
  interruptAfterMs: number;
  /** ms to settle after interrupt before returning. */
  postCycleSettleMs: number;
};

export async function runOneCycle(args: RunOneCycleArgs): Promise<CycleLocalRecord> {
  const errors: string[] = [];
  const { session, arm, driveStrategy, row, cycleIndex, interruptAfterMs } = args;

  let sayCallTs = 0;
  let interruptCallTs: number | null = null;

  try {
    if (driveStrategy === 'update-then-speak') {
      // Arm 3: rewrite the system prompt to target this segment, then trigger
      // speech via say(). The LLM (we hope) reads the prompt verbatim.
      const update: AgentConfigUpdate = {
        llm: {
          system_messages: [
            {
              role: 'system',
              content: `You are a voice narrator. Read the following text aloud, verbatim, without paraphrasing or adding commentary. Stop after reading.\n\nText to read:\n${row.text}`,
            },
          ],
        },
      };
      await session.update(update);
      sayCallTs = Date.now();
      await session.say(row.text, { priority: 'INTERRUPT' });
    } else if (driveStrategy === 'speak-api') {
      // Arm 1 / Arm 2: push the segment text directly via /speak.
      sayCallTs = Date.now();
      await session.say(row.text, { priority: 'INTERRUPT' });
    } else if (driveStrategy === 'llm-via-prompt') {
      // Baseline: no orchestrator drive. Record a pseudo-say timestamp so the
      // missing-turn outcome maps to deterministic C2 fail.
      sayCallTs = Date.now();
    }
  } catch (err) {
    errors.push(`drive failed: ${(err as Error).message}`);
  }

  // Let the agent speak for `interruptAfterMs` then fire interrupt.
  // For baseline this is still useful — it bounds the wall-clock per cycle.
  await new Promise((r) => setTimeout(r, interruptAfterMs));

  try {
    interruptCallTs = Date.now();
    await session.interrupt();
  } catch (err) {
    errors.push(`interrupt failed: ${(err as Error).message}`);
  }

  if (args.postCycleSettleMs > 0) {
    await new Promise((r) => setTimeout(r, args.postCycleSettleMs));
  }

  return {
    arm,
    row_id: row.row_id,
    cycle: cycleIndex,
    segment_text: row.text,
    say_call_ts: sayCallTs,
    interrupt_call_ts: interruptCallTs,
    errors,
    drive_strategy: driveStrategy,
  };
}

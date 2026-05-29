// Compute C1, C2, C3 from local cycle records + post-stop turn analytics.
//
// Matching strategy: turns are returned in chronological order. We filter to
// `start.type === 'api_speak'` turns and pair them in order with the
// `say-api` and `update-then-speak` cycles. `llm-via-prompt` (baseline)
// cycles do NOT call say(), so they never produce an api_speak turn — those
// cycles get nulls (which deterministically fail C1/C2).

import type { AgentSession } from 'agora-agent-server-sdk';
import type { CycleLocalRecord } from '../cycle.js';

type Turn = NonNullable<Awaited<ReturnType<AgentSession['getTurns']>>['turns']>[number];

export type CyclePassCriteria = {
  /** C1: interrupt -> silence (ms). Pass if < 300. */
  interrupt_to_silence_ms: number | null;
  /** C2: speak -> first audio (ms). Pass if < 800. */
  speak_to_first_audio_ms: number | null;
  /** C3: token-Jaccard overlap of transcript vs requested text. Pass if >= 0.9. */
  content_jaccard: number | null;
  c1_pass: boolean;
  c2_pass: boolean;
  c3_pass: boolean;
  /** TTS Time-To-First-Byte from Agora-side metrics. */
  tts_ttfb_ms: number | null;
  /** End-to-end latency from Agora-side metrics. */
  e2e_latency_ms: number | null;
  /** Algorithm processing delay (Agora-side). */
  algorithm_processing_ms: number | null;
};

export type ScoredRecord = CycleLocalRecord & {
  matched_turn_id: number | null;
  turn_start_at: number | null;
  turn_end_at: number | null;
  turn_end_type: string | null;
  turn_end_caused_by: string | null;
  spoken_text: string | null;
  scores: CyclePassCriteria;
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const unionSize = setA.size + setB.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

function nullScores(): CyclePassCriteria {
  return {
    interrupt_to_silence_ms: null,
    speak_to_first_audio_ms: null,
    content_jaccard: null,
    c1_pass: false,
    c2_pass: false,
    c3_pass: false,
    tts_ttfb_ms: null,
    e2e_latency_ms: null,
    algorithm_processing_ms: null,
  };
}

/**
 * Pair cycles to turns. Returns ScoredRecord[] in the same order as `cycles`.
 *
 * `turns` should be the full getTurns() result, sorted by start_at ascending.
 * `historyByAssistant` is optional — pass an in-order list of assistant
 * utterances pulled from getHistory(), used as a best-effort C3 source for
 * arms that go through the LLM (arm3, baseline).
 */
export function scoreCycles(args: {
  cycles: CycleLocalRecord[];
  turns: Turn[];
  historyAssistantUtterances?: string[];
}): ScoredRecord[] {
  const { cycles, turns } = args;
  const history = args.historyAssistantUtterances ?? [];

  // Sort turns by start_at ascending, filter to api_speak only.
  const apiSpeakTurns = turns
    .filter(
      (t) =>
        t.start?.type === 'api_speak' && typeof t.start.start_at === 'number',
    )
    .sort((a, b) => (a.start!.start_at as number) - (b.start!.start_at as number));

  // Drive-able cycles (the ones that call session.say) are arm1/2/3.
  // Baseline cycles still try to call interrupt but don't produce api_speak turns.
  const driveableCycles = cycles.filter((c) => c.drive_strategy !== 'llm-via-prompt');

  const turnByCycleIndex = new Map<CycleLocalRecord, Turn>();
  for (let i = 0; i < driveableCycles.length && i < apiSpeakTurns.length; i++) {
    turnByCycleIndex.set(driveableCycles[i], apiSpeakTurns[i]);
  }

  return cycles.map((cycle, idx) => {
    const turn = turnByCycleIndex.get(cycle) ?? null;
    const spoken =
      // C3 source: for say-api / update-then-speak arms, the spoken text equals
      // segment_text by construction (TTS-direct). Use history as cross-check.
      cycle.drive_strategy !== 'llm-via-prompt'
        ? cycle.segment_text
        : history[idx] ?? null;

    if (!turn) {
      const scores = nullScores();
      return {
        ...cycle,
        matched_turn_id: null,
        turn_start_at: null,
        turn_end_at: null,
        turn_end_type: null,
        turn_end_caused_by: null,
        spoken_text: spoken,
        scores: { ...scores, content_jaccard: spoken ? jaccard(cycle.segment_text, spoken) : null },
      };
    }

    const startAt = (turn.start!.start_at as number) ?? null;
    const endAt = turn.end?.end_at ?? null;
    const c2 = startAt != null ? startAt - cycle.say_call_ts : null;
    const c1 = endAt != null && cycle.interrupt_call_ts != null ? endAt - cycle.interrupt_call_ts : null;
    const ttsTtfb =
      turn.metrics?.segmented_latency_ms?.find((s) => s.name === 'tts_ttfb')?.latency ??
      null;
    const algoProc =
      turn.metrics?.segmented_latency_ms?.find((s) => s.name === 'algorithm_processing')
        ?.latency ?? null;
    const jacc = spoken != null ? jaccard(cycle.segment_text, spoken) : null;

    return {
      ...cycle,
      matched_turn_id: turn.turn_id ?? null,
      turn_start_at: startAt,
      turn_end_at: endAt,
      turn_end_type: turn.end?.type ?? null,
      turn_end_caused_by: turn.end?.metadata?.caused_by ?? null,
      spoken_text: spoken,
      scores: {
        interrupt_to_silence_ms: c1,
        speak_to_first_audio_ms: c2,
        content_jaccard: jacc,
        c1_pass: c1 != null && c1 < 300,
        c2_pass: c2 != null && c2 < 800,
        c3_pass: jacc != null && jacc >= 0.9,
        tts_ttfb_ms: ttsTtfb,
        e2e_latency_ms: turn.metrics?.e2e_latency_ms ?? null,
        algorithm_processing_ms: algoProc,
      },
    };
  });
}

/**
 * Poll getTurns() until it returns non-empty, up to maxWaitMs.
 * Call this AFTER session.stop().
 */
export async function fetchTurnsAfterStop(
  session: AgentSession,
  maxWaitMs = 8000,
  pollIntervalMs = 500,
): Promise<Turn[]> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const t = await session.getTurns();
      if (t.turns && t.turns.length > 0) return t.turns;
    } catch {
      // ignore; retry
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return [];
}

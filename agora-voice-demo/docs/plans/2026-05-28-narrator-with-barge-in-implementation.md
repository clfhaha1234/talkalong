# Talkthrough Phase 3 + 4 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Add barge-in Q&A + graceful resume (with LLM-driven incremental re-script and bridge line) to the existing Phase 1 narrator, per the approved design.

**Architecture:** Option C from PRD §4.6 (hybrid). Server owns the dual state machine + bridge/rescript LLM calls; browser owns RTM event subscription (reusing `AgoraVoiceAI` from `agora-agent-client-toolkit`) and the end-of-QA silence-timer detector. Narrator is rewritten to push all segments via `session.say({priority: 'APPEND'})` — Agora queues them with zero gap.

**Tech Stack:** Next.js 16 App Router · TypeScript · `agora-agent-server-sdk` 1.3 · `agora-agent-client-toolkit` 1.2 · `agora-rtc-react` 2.5 · Gemini 3.1 Flash Lite via OpenAI-compat endpoint (with `reasoning_effort: 'minimal'`) · vitest for unit tests

**Reference docs:**
- Approved design: [`docs/plans/2026-05-28-narrator-with-barge-in-design.md`](2026-05-28-narrator-with-barge-in-design.md)
- Parent PRD v0.3: [`docs/proactive-tutor-engine-prd.md`](../proactive-tutor-engine-prd.md)
- E1 cycle pattern (reuse for E2 integration test): `agora-voice-demo/scripts/e1/cycle.ts`
- Existing browser RTM pattern: `agora-voice-demo/components/ConversationComponent.tsx:159-260`

**All paths in this plan are relative to `agora-voice-demo/` unless stated otherwise.**

**Commit convention** (per repo AGENTS.md):
- Conventional commits, lowercase after prefix: `feat(scope): description`
- No AI tool names in messages
- No `Co-Authored-By` trailers
- No `--no-verify`

---

## Task 0: Probe Agora session-config plumbing (BLOCKS everything else)

> **Why first:** Design §6.1 — we know we need `filler_words`, `turn_detection`, `advanced_features.enable_rtm`, `parameters.data_channel`, but the `agora-agent-server-sdk` typed `AgentSessionOptions` does NOT expose them. Until we know the right path (typed builder vs `session.raw` REST vs `session.update()` post-start), every later task that touches Agora config is blocked.

**Files:**
- Create: `scripts/probe-agora-config.ts`

**Step 1: Write the probe**

```typescript
// scripts/probe-agora-config.ts
//
// Goal: discover how to pass filler_words + turn_detection + RTM flags into
// AgentSession. Try three paths in order; print which one is accepted.

import {
  AgoraClient,
  Area,
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
  ExpiresIn,
} from 'agora-agent-server-sdk';
import { env } from './e1/lib/env.js';

async function main() {
  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });

  const agent = new Agent({
    name: `probe-config-${Date.now()}`,
    instructions: 'Silent narrator. Do not speak until told to.',
    greeting: '',
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini' }))
    .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: 'English_captivating_female1' }));

  // PATH 1: pass via createSession options (untyped — see if SDK accepts extra keys)
  const session = agent.createSession(client, {
    channel: `probe-${Date.now()}`,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(5),
    debug: true,
    // The keys we want to inject — these are not in the typed interface
    // but the underlying REST API accepts them. See if the SDK passes them through.
    advanced_features: { enable_rtm: true },
    parameters: {
      data_channel: 'rtm',
      enable_metrics: true,
      enable_error_message: true,
    },
    filler_words: {
      trigger: { type: 'fixed_time', config: { delay_ms: 800 } },
      content: {
        type: 'static',
        selection_rule: 'random',
        utterances: ['Hmm.', 'Let me see.', 'One sec.'],
      },
    },
    turn_detection: {
      config: {
        start_of_speech: { mode: 'vad' },
        end_of_speech: { mode: 'semantic' },
      },
    },
  } as Parameters<typeof agent.createSession>[1] & Record<string, unknown>);

  console.log('PATH 1 (createSession options): attempting start...');
  try {
    const agentId = await session.start();
    console.log(`  ✓ start() OK; agentId=${agentId}`);
    // Now check that the extra config landed via session.raw.get
    try {
      const info = await session.raw.get({ appid: client.appId, agentId });
      console.log('  session.raw.get() response keys:', Object.keys(info as object));
      console.log('  full info:', JSON.stringify(info, null, 2));
    } catch (e) {
      console.log('  could not query raw info:', (e as Error).message);
    }
    await session.stop();
  } catch (err) {
    console.log(`  ✗ PATH 1 failed: ${(err as Error).message}`);
  }

  // PATH 2: via session.update() after start
  console.log('\nPATH 2 (session.update after start): attempting...');
  const session2 = agent.createSession(client, {
    channel: `probe2-${Date.now()}`,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(5),
  });
  try {
    await session2.start();
    await session2.update({
      // These fields might be supported by update; try them
      advanced_features: { enable_rtm: true },
      parameters: {
        data_channel: 'rtm',
        enable_metrics: true,
      },
    } as Parameters<typeof session2.update>[0] & Record<string, unknown>);
    console.log('  ✓ update() OK');
    await session2.stop();
  } catch (err) {
    console.log(`  ✗ PATH 2 failed: ${(err as Error).message}`);
  }

  // PATH 3: bypass the SDK entirely — direct REST via session.raw
  console.log('\nPATH 3 (session.raw direct REST passthrough): documenting...');
  console.log('  Inspect node_modules/agora-agent-server-sdk/dist/cjs/api/resources/agents/client/Client.d.ts');
  console.log('  Look for a join() method that takes the full Properties shape with these fields.');
}

main().catch((e) => {
  console.error('probe fatal:', e);
  process.exit(1);
});
```

**Step 2: Run the probe**

```bash
node --import tsx scripts/probe-agora-config.ts 2>&1 | tee /tmp/agora-config-probe.log
```

Expected: one of three paths succeeds and the `session.raw.get()` response confirms `filler_words` and `turn_detection` are present in the agent's config. Read `/tmp/agora-config-probe.log` carefully.

**Step 3: Document the finding**

Create a 1-paragraph note at the top of `lib/orchestrator/index.ts` (will be overwritten later) describing which path works and which SDK methods to call. If NONE of the three paths work, the design needs revision before continuing — escalate back to brainstorming.

**Step 4: Commit**

```bash
cd <repo>/agora-voice-demo
git add scripts/probe-agora-config.ts
git commit -m "feat(scripts): probe agora session config plumbing paths"
```

---

## Task 1: Install vitest and configure

**Files:**
- Modify: `package.json` (add `vitest` + script)
- Create: `vitest.config.ts`

**Step 1: Install**

```bash
cd <repo>/agora-voice-demo
pnpm add -D vitest @vitest/coverage-v8
```

**Step 2: Add vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

**Step 3: Add test script to package.json**

Modify `package.json` `scripts` block — add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify**

```bash
pnpm test 2>&1 | tail -5
```

Expected: `No test files found, exiting with code 1` (we haven't written any yet — that's fine).

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore(test): add vitest for unit tests"
```

---

## Task 2: Outer state machine (state-machine.ts) — pure logic

**Files:**
- Create: `lib/orchestrator/state-machine.ts`
- Create: `lib/orchestrator/state-machine.test.ts`

**Step 1: Write the failing tests**

```typescript
// lib/orchestrator/state-machine.test.ts
import { describe, it, expect } from 'vitest';
import { transition, isTerminalState } from './state-machine';
import type { OuterState, FsmEvent } from './state-machine';

describe('outer FSM transitions', () => {
  it('IDLE + session_start → MAIN', () => {
    expect(transition('IDLE', { type: 'session_start' })).toBe('MAIN');
  });
  it('MAIN + barge_in → BRANCH', () => {
    expect(transition('MAIN', { type: 'barge_in' })).toBe('BRANCH');
  });
  it('BRANCH + resume_complete → MAIN', () => {
    expect(transition('BRANCH', { type: 'resume_complete' })).toBe('MAIN');
  });
  it('MAIN + all_done → DONE', () => {
    expect(transition('MAIN', { type: 'all_done' })).toBe('DONE');
  });
  it('ANY + error → ERROR', () => {
    expect(transition('MAIN', { type: 'error', message: 'x' })).toBe('ERROR');
    expect(transition('BRANCH', { type: 'error', message: 'x' })).toBe('ERROR');
    expect(transition('IDLE', { type: 'error', message: 'x' })).toBe('ERROR');
  });
  it('throws on undefined transitions', () => {
    expect(() => transition('DONE', { type: 'session_start' })).toThrow(
      /no transition: DONE \+ session_start/,
    );
    expect(() => transition('ERROR', { type: 'session_start' })).toThrow(
      /no transition: ERROR \+ session_start/,
    );
  });
  it('isTerminalState: DONE and ERROR are terminal; others are not', () => {
    expect(isTerminalState('DONE')).toBe(true);
    expect(isTerminalState('ERROR')).toBe(true);
    expect(isTerminalState('IDLE')).toBe(false);
    expect(isTerminalState('MAIN')).toBe(false);
    expect(isTerminalState('BRANCH')).toBe(false);
  });
});
```

**Step 2: Run, expect FAIL**

```bash
pnpm test 2>&1 | tail -10
```

Expected: `Error: Failed to load url ./state-machine` (file missing).

**Step 3: Implement**

```typescript
// lib/orchestrator/state-machine.ts
//
// Outer state machine for the tutor session.
//
// States: IDLE → MAIN ↔ BRANCH → DONE; any state can transition to ERROR.
// Pure logic — no IO. Transitions are total over the (state × event) table
// in design doc §2.1; undefined combinations throw to catch bugs early.

export type OuterState = 'IDLE' | 'MAIN' | 'BRANCH' | 'DONE' | 'ERROR';

export type FsmEvent =
  | { type: 'session_start' }
  | { type: 'barge_in' }
  | { type: 'resume_complete' }
  | { type: 'all_done' }
  | { type: 'error'; message: string };

export function transition(state: OuterState, event: FsmEvent): OuterState {
  if (event.type === 'error') return 'ERROR';
  const key = `${state}+${event.type}` as const;
  switch (key) {
    case 'IDLE+session_start': return 'MAIN';
    case 'MAIN+barge_in': return 'BRANCH';
    case 'BRANCH+resume_complete': return 'MAIN';
    case 'MAIN+all_done': return 'DONE';
    default:
      throw new Error(`no transition: ${state} + ${event.type}`);
  }
}

export function isTerminalState(s: OuterState): boolean {
  return s === 'DONE' || s === 'ERROR';
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test 2>&1 | tail -10
```

Expected: 7 passing, 0 failing.

**Step 5: Commit**

```bash
git add lib/orchestrator/state-machine.ts lib/orchestrator/state-machine.test.ts
git commit -m "feat(orchestrator): outer state machine with transition table"
```

---

## Task 3: Extend ProgressState with branch_line + comprehension_signal

**Files:**
- Modify: `lib/orchestrator/types.ts` (add fields)
- Modify: `lib/orchestrator/progress-state.ts`
- Create: `lib/orchestrator/progress-state.test.ts`

**Step 1: Extend types**

In `lib/orchestrator/types.ts`, replace the existing `BranchLineState` interface with:

```typescript
export interface BranchLineState {
  active: boolean;
  paused_segment_id: string | null;
  user_question: string | null;
  qa_turn_count: number;
  qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }>;
  started_at: number | null;
  expected_resume_segment_id: string | null;
}

export interface ComprehensionSignal {
  depth_setting: 'simpler' | 'default' | 'deeper';
  elicitations_asked: number;
  elicitations_correct: number;
  qa_turns_total: number;
  qa_followup_depth_avg: number;
}
```

And add `comprehension` to `ProgressSnapshot`:

```typescript
export interface ProgressSnapshot {
  session_id: string;
  outer_state: OrchestratorOuterState;
  main_line: MainLineState;
  branch_line: BranchLineState;
  comprehension: ComprehensionSignal;
  updated_at: number;
  total_segments: number;
}
```

Also extend `ProgressEvent`:

```typescript
export type ProgressEvent =
  | { type: 'snapshot'; snapshot: ProgressSnapshot }
  | { type: 'segment_started'; segment_id: string; segment_index: number; text: string }
  | { type: 'segment_completed'; segment_id: string }
  | { type: 'branch_started'; paused_segment_id: string }
  | { type: 'branch_ended'; paused_segment_id: string }
  | { type: 'bridge_started'; text: string }
  | { type: 'bridge_completed' }
  | { type: 'comprehension_changed'; signal: ComprehensionSignal }
  | { type: 'narration_complete' }
  | { type: 'error'; message: string }
  | { type: 'session_started'; channel: string; agent_id: string; rtc_token: string; rtm_token: string; client_uid: string };
```

**Step 2: Write the failing tests**

```typescript
// lib/orchestrator/progress-state.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ProgressState } from './progress-state';
import type { Segment } from './types';

function fakeSegment(id: string, text = 'hello'): Segment {
  return {
    id,
    range: { start: 0, end: text.length },
    text,
    approx_duration_ms: 1000,
    category: 'exposition',
    elicitation_node: false,
  };
}

describe('ProgressState branch + comprehension', () => {
  const segs = [fakeSegment('s1'), fakeSegment('s2'), fakeSegment('s3')];

  it('enterBranch records paused segment + emits branch_started', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[1]); // currently on s2
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.enterBranch();
    expect(ps.snapshot().branch_line.active).toBe(true);
    expect(ps.snapshot().branch_line.paused_segment_id).toBe('s2');
    expect(events.find((e) => e.type === 'branch_started')).toBeTruthy();
  });

  it('exitBranch emits branch_ended and clears branch state', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[1]);
    ps.enterBranch();
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.exitBranch();
    expect(ps.snapshot().branch_line.active).toBe(false);
    expect(events.find((e) => e.type === 'branch_ended')).toBeTruthy();
  });

  it('recordQaTurn increments qa_turn_count and appends history', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[0]);
    ps.enterBranch();
    ps.recordQaTurn('user', 'why?');
    ps.recordQaTurn('agent', 'because of X');
    expect(ps.snapshot().branch_line.qa_turn_count).toBe(2);
    expect(ps.snapshot().branch_line.qa_history.length).toBe(2);
    expect(ps.snapshot().branch_line.qa_history[0].text).toBe('why?');
  });

  it('updateComprehension fires comprehension_changed event', () => {
    const ps = new ProgressState('sess1', segs);
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    ps.updateComprehension({ depth_setting: 'deeper', elicitations_asked: 1, elicitations_correct: 1, qa_turns_total: 0, qa_followup_depth_avg: 0 });
    expect(events.find((e) => e.type === 'comprehension_changed')?.signal.depth_setting).toBe('deeper');
  });

  it('replaceSegments swaps next-N segments after rescript', () => {
    const ps = new ProgressState('sess1', segs);
    ps.startSegment(segs[0]);
    const newS2 = fakeSegment('s2', 'rewritten s2');
    const newS3 = fakeSegment('s3', 'rewritten s3');
    ps.replaceSegments(['s2', 's3'], [newS2, newS3]);
    // segments array updated
    expect(ps.segments.find((s) => s.id === 's2')!.text).toBe('rewritten s2');
    expect(ps.segments.find((s) => s.id === 's3')!.text).toBe('rewritten s3');
  });
});
```

**Step 3: Run, expect FAIL**

```bash
pnpm test progress-state 2>&1 | tail -15
```

Expected: tests fail because `enterBranch`, `exitBranch`, `recordQaTurn`, `updateComprehension`, `replaceSegments` don't exist.

**Step 4: Implement**

Modify `lib/orchestrator/progress-state.ts` — add methods after `finish()`:

```typescript
// Branch lifecycle
enterBranch(): void {
  this.outer = 'BRANCH';
  this.branch = {
    active: true,
    paused_segment_id: this.main.current_segment_id,
    user_question: null,
    qa_turn_count: 0,
    qa_history: [],
    started_at: Date.now(),
    expected_resume_segment_id: this.main.current_segment_id,
  };
  this.emit('event', { type: 'branch_started', paused_segment_id: this.branch.paused_segment_id ?? '' } satisfies ProgressEvent);
  this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
}

exitBranch(): void {
  const paused = this.branch.paused_segment_id ?? '';
  this.branch = {
    active: false,
    paused_segment_id: null,
    user_question: null,
    qa_turn_count: 0,
    qa_history: [],
    started_at: null,
    expected_resume_segment_id: null,
  };
  this.outer = 'MAIN';
  this.emit('event', { type: 'branch_ended', paused_segment_id: paused } satisfies ProgressEvent);
  this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
}

recordQaTurn(role: 'user' | 'agent', text: string): void {
  if (!this.branch.active) return;
  this.branch.qa_history.push({ role, text, ts: Date.now() });
  this.branch.qa_turn_count++;
  this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
}

updateComprehension(next: ComprehensionSignal): void {
  this.comprehension = { ...next };
  this.emit('event', { type: 'comprehension_changed', signal: this.comprehension } satisfies ProgressEvent);
  this.emit('event', { type: 'snapshot', snapshot: this.snapshot() } satisfies ProgressEvent);
}

replaceSegments(targetIds: string[], replacements: Segment[]): void {
  if (targetIds.length !== replacements.length) {
    throw new Error('replaceSegments length mismatch');
  }
  // segments array is readonly per the existing class — make it mutable
  for (let i = 0; i < targetIds.length; i++) {
    const idx = this.segments.findIndex((s) => s.id === targetIds[i]);
    if (idx >= 0) (this.segments as Segment[])[idx] = replacements[i];
  }
}
```

Also add `private comprehension` field to constructor with default:
```typescript
private comprehension: ComprehensionSignal = {
  depth_setting: 'default',
  elicitations_asked: 0,
  elicitations_correct: 0,
  qa_turns_total: 0,
  qa_followup_depth_avg: 0,
};
```

And update `snapshot()` to include `comprehension`.

Also import `ComprehensionSignal` at the top.

**Step 5: Run, expect PASS**

```bash
pnpm test progress-state 2>&1 | tail -5
```

Expected: 5 passing.

**Step 6: Commit**

```bash
git add lib/orchestrator/types.ts lib/orchestrator/progress-state.ts lib/orchestrator/progress-state.test.ts
git commit -m "feat(orchestrator): extend ProgressState with branch_line and comprehension signal"
```

---

## Task 4: barge-in scheduler (Phase 3 ships answer_now only)

**Files:**
- Create: `lib/orchestrator/barge-in-scheduler.ts`
- Create: `lib/orchestrator/barge-in-scheduler.test.ts`

**Step 1: Write tests**

```typescript
// lib/orchestrator/barge-in-scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { classify } from './barge-in-scheduler';

describe('barge-in scheduler — Phase 3 stub', () => {
  it('always returns answer_now for now', () => {
    expect(classify({ question: 'wait, why?', remaining_segment_texts: [] })).toBe('answer_now');
    expect(classify({ question: 'hello', remaining_segment_texts: ['random'] })).toBe('answer_now');
  });

  it('exposes a stable type', () => {
    const decisions = ['answer_now', 'defer_to_segment', 'dismiss_gently'] as const;
    type _D = (typeof decisions)[number];
    const r: _D = classify({ question: 'x', remaining_segment_texts: [] });
    expect(decisions).toContain(r);
  });
});
```

**Step 2: Run, expect FAIL** — file missing.

**Step 3: Implement**

```typescript
// lib/orchestrator/barge-in-scheduler.ts
//
// Phase 3 scope: ships answer_now-only. The other two decisions
// (defer_to_segment, dismiss_gently) are stubbed for the typed surface but
// always fall through to answer_now. Phase 5 / 7 will train a real classifier.

export type BargeInDecision = 'answer_now' | 'defer_to_segment' | 'dismiss_gently';

export interface ClassifyArgs {
  question: string;
  remaining_segment_texts: string[];
}

export function classify(_args: ClassifyArgs): BargeInDecision {
  return 'answer_now';
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test barge-in 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/orchestrator/barge-in-scheduler.ts lib/orchestrator/barge-in-scheduler.test.ts
git commit -m "feat(orchestrator): barge-in scheduler stub (answer_now only)"
```

---

## Task 5: Bridge fallback library

**Files:**
- Create: `lib/orchestrator/bridge-library.ts`
- Create: `lib/orchestrator/bridge-library.test.ts`

**Step 1: Tests**

```typescript
// lib/orchestrator/bridge-library.test.ts
import { describe, it, expect } from 'vitest';
import { BRIDGES, pickBridge } from './bridge-library';

describe('bridge library', () => {
  it('has at least 10 entries', () => {
    expect(BRIDGES.length).toBeGreaterThanOrEqual(10);
  });
  it('entries are 4-6 second utterances (rough: 60-180 chars)', () => {
    for (const b of BRIDGES) {
      expect(b.length).toBeGreaterThanOrEqual(60);
      expect(b.length).toBeLessThanOrEqual(180);
    }
  });
  it('pickBridge returns one of the entries', () => {
    const b = pickBridge();
    expect(BRIDGES).toContain(b);
  });
  it('pickBridge gives variety over multiple calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(pickBridge());
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});
```

**Step 2: Run, expect FAIL** — file missing.

**Step 3: Implement**

```typescript
// lib/orchestrator/bridge-library.ts
//
// Fallback bridge lines used when the LLM bridge call exceeds the budget
// or fails. Phrased to be content-agnostic so they fit any paused segment.

export const BRIDGES: string[] = [
  "Right, so to bring it back to where we were — let me pick up from the last point.",
  "Okay, that's a good one to set down for now. Coming back to the main thread.",
  "Got it. So back to what we were talking about — let me keep going.",
  "Alright. Picking up where we left off — here's what came next.",
  "Sure thing. Back to the through-line — the next part is where it gets interesting.",
  "Fair enough. So, coming back to our story — let me keep reading.",
  "Hmm, makes sense. Now back to where we were, here's the next bit.",
  "Got that. Returning to the main thread — let me pick it up from there.",
  "Right. So back to where we paused, the next thing to know is —",
  "Okay. Coming back around — let me carry on from where we left off.",
  "Mmhmm. So, back to the main story — let me keep going from there.",
  "Sure. Let me bring us back to where we were, just before that question.",
];

export function pickBridge(): string {
  return BRIDGES[Math.floor(Math.random() * BRIDGES.length)];
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test bridge-library 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/orchestrator/bridge-library.ts lib/orchestrator/bridge-library.test.ts
git commit -m "feat(orchestrator): bridge fallback library"
```

---

## Task 6: bridge.ts LLM call + watchdog

**Files:**
- Create: `lib/orchestrator/bridge.ts`
- Create: `lib/orchestrator/bridge.test.ts`

**Step 1: Tests**

```typescript
// lib/orchestrator/bridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateBridge } from './bridge';

describe('bridge LLM with watchdog', () => {
  it('returns LLM output when call resolves within budget', async () => {
    const llm = vi.fn().mockResolvedValue('Right — so to your question about X, we have the answer. Coming back to the main thread.');
    const res = await generateBridge(
      { qa_history: [{ role: 'user', text: 'why?', ts: 0 }, { role: 'agent', text: 'because.', ts: 1 }], paused_segment_text: 'The third step is...', next_segment_text: 'After that...' },
      { llm, budget_ms: 1500 },
    );
    expect(res.source).toBe('llm');
    expect(res.text).toContain('coming back');
  });

  it('falls back to library when LLM exceeds budget', async () => {
    const llm = vi.fn().mockImplementation(() => new Promise<string>(() => {})); // never resolves
    const res = await generateBridge(
      { qa_history: [], paused_segment_text: 's', next_segment_text: 'n' },
      { llm, budget_ms: 50 },
    );
    expect(res.source).toBe('fallback');
    expect(res.text.length).toBeGreaterThan(30);
  });

  it('falls back when LLM throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('429'));
    const res = await generateBridge(
      { qa_history: [], paused_segment_text: 's', next_segment_text: 'n' },
      { llm, budget_ms: 1500 },
    );
    expect(res.source).toBe('fallback');
  });
});
```

**Step 2: Run, expect FAIL** — file missing.

**Step 3: Implement**

```typescript
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
```

**Step 4: Run, expect PASS**

```bash
pnpm test bridge 2>&1 | tail -10
```

Expected: 3 passing.

**Step 5: Commit**

```bash
git add lib/orchestrator/bridge.ts lib/orchestrator/bridge.test.ts
git commit -m "feat(orchestrator): bridge LLM with watchdog and library fallback"
```

---

## Task 7: rescript.ts LLM call + watchdog

**Files:**
- Create: `lib/orchestrator/rescript.ts`
- Create: `lib/orchestrator/rescript.test.ts`

**Step 1: Tests**

```typescript
// lib/orchestrator/rescript.test.ts
import { describe, it, expect, vi } from 'vitest';
import { rescriptSegments } from './rescript';
import type { Segment } from './types';

function seg(id: string, text: string): Segment {
  return { id, range: { start: 0, end: text.length }, text, approx_duration_ms: 1000, category: 'exposition', elicitation_node: false };
}

describe('rescript LLM with watchdog', () => {
  it('returns rewritten segments when LLM resolves within budget', async () => {
    const originals = [seg('s4', 'The third step is X.'), seg('s5', 'After that, Y.')];
    const llm = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 's4', text: 'Since you asked about X, the third step is X-revised.' },
      { id: 's5', text: 'After that, Y-revised.' },
    ]));
    const res = await rescriptSegments(
      { originals, qa_history: [{ role: 'user', text: 'X?', ts: 0 }], depth_setting: 'default' },
      { llm, budget_ms: 3000 },
    );
    expect(res.source).toBe('llm');
    expect(res.segments.length).toBe(2);
    expect(res.segments[0].text).toContain('X-revised');
  });

  it('returns originals on timeout', async () => {
    const originals = [seg('s4', 'A.'), seg('s5', 'B.')];
    const llm = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    const res = await rescriptSegments(
      { originals, qa_history: [], depth_setting: 'default' },
      { llm, budget_ms: 30 },
    );
    expect(res.source).toBe('fallback');
    expect(res.segments[0].text).toBe('A.');
  });

  it('returns originals on malformed LLM response', async () => {
    const originals = [seg('s4', 'A.')];
    const llm = vi.fn().mockResolvedValue('not json at all');
    const res = await rescriptSegments(
      { originals, qa_history: [], depth_setting: 'default' },
      { llm, budget_ms: 3000 },
    );
    expect(res.source).toBe('fallback');
  });
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```typescript
// lib/orchestrator/rescript.ts
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
```

**Step 4: Run, expect PASS**

```bash
pnpm test rescript 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/orchestrator/rescript.ts lib/orchestrator/rescript.test.ts
git commit -m "feat(orchestrator): rescript LLM with watchdog and original-segments fallback"
```

---

## Task 8: comprehension-tracker.ts

**Files:**
- Create: `lib/orchestrator/comprehension-tracker.ts`
- Create: `lib/orchestrator/comprehension-tracker.test.ts`

**Step 1: Tests**

```typescript
// lib/orchestrator/comprehension-tracker.test.ts
import { describe, it, expect } from 'vitest';
import { ComprehensionTracker } from './comprehension-tracker';

describe('comprehension tracker', () => {
  it('starts at default', () => {
    const t = new ComprehensionTracker();
    expect(t.signal().depth_setting).toBe('default');
  });

  it('many correct elicitations → deeper', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 3; i++) t.onElicitation(true);
    expect(t.signal().depth_setting).toBe('deeper');
  });

  it('mostly wrong / silent → simpler', () => {
    const t = new ComprehensionTracker();
    t.onElicitation(false);
    t.onElicitation(false);
    t.onElicitation(false);
    expect(t.signal().depth_setting).toBe('simpler');
  });

  it('high QA depth signals confusion → simpler', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 5; i++) t.onQaTurn();
    expect(t.signal().depth_setting).toBe('simpler');
  });

  it('flips at most once per session for demo simplicity', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 3; i++) t.onElicitation(true);
    expect(t.signal().depth_setting).toBe('deeper');
    for (let i = 0; i < 5; i++) t.onQaTurn();
    // Already flipped to deeper; second flip is suppressed
    expect(t.signal().depth_setting).toBe('deeper');
  });
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```typescript
// lib/orchestrator/comprehension-tracker.ts
//
// Demo-grade comprehension signal. Tracks elicitation hit-rate and Q&A
// follow-up depth. Flips depth_setting at most once per session for
// stability — Phase 5+ can lift this cap once the signal is empirically
// well-calibrated.

import type { ComprehensionSignal } from './types';

export class ComprehensionTracker {
  private elicitations_asked = 0;
  private elicitations_correct = 0;
  private qa_turns_total = 0;
  private depth: ComprehensionSignal['depth_setting'] = 'default';
  private flipped = false;

  onElicitation(correct: boolean): void {
    this.elicitations_asked++;
    if (correct) this.elicitations_correct++;
    this.recompute();
  }

  onQaTurn(): void {
    this.qa_turns_total++;
    this.recompute();
  }

  signal(): ComprehensionSignal {
    return {
      depth_setting: this.depth,
      elicitations_asked: this.elicitations_asked,
      elicitations_correct: this.elicitations_correct,
      qa_turns_total: this.qa_turns_total,
      qa_followup_depth_avg: 0, // placeholder for future enrichment
    };
  }

  private recompute(): void {
    if (this.flipped) return;
    const correctRate = this.elicitations_asked > 0
      ? this.elicitations_correct / this.elicitations_asked
      : 0;
    if (this.elicitations_asked >= 3 && correctRate >= 0.8) {
      this.depth = 'deeper';
      this.flipped = true;
      return;
    }
    if (this.elicitations_asked >= 3 && correctRate <= 0.34) {
      this.depth = 'simpler';
      this.flipped = true;
      return;
    }
    if (this.qa_turns_total >= 5) {
      this.depth = 'simpler';
      this.flipped = true;
    }
  }
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test comprehension 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/orchestrator/comprehension-tracker.ts lib/orchestrator/comprehension-tracker.test.ts
git commit -m "feat(orchestrator): comprehension tracker with single-flip depth dial"
```

---

## Task 9: narrator.ts replacement (APPEND-only, no sleep)

**Files:**
- Modify: `lib/orchestrator/narrator.ts`
- Create: `lib/orchestrator/narrator.test.ts`

**Step 1: Tests**

```typescript
// lib/orchestrator/narrator.test.ts
//
// Narrator is mostly IO (calls session.say()). We test the queue/loop
// behaviour with a fake session that records the calls.

import { describe, it, expect, vi } from 'vitest';
import { runNarration } from './narrator';
import { ProgressState } from './progress-state';
import type { Segment } from './types';
import type { AgentSession } from 'agora-agent-server-sdk';

function seg(id: string, text: string): Segment {
  return { id, range: { start: 0, end: text.length }, text, approx_duration_ms: 1000, category: 'exposition', elicitation_node: false };
}

function fakeSession(): AgentSession & { _calls: Array<{ text: string; priority: string | undefined }> } {
  const calls: Array<{ text: string; priority: string | undefined }> = [];
  return {
    _calls: calls,
    say: vi.fn(async (text: string, opts?: { priority?: string }) => {
      calls.push({ text, priority: opts?.priority });
    }),
    interrupt: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as AgentSession & { _calls: typeof calls };
}

describe('narrator (APPEND-only)', () => {
  it('pushes every segment via APPEND in order', async () => {
    const segs = [seg('s1', 'a'), seg('s2', 'b'), seg('s3', 'c')];
    const ps = new ProgressState('sess', segs);
    const sess = fakeSession();
    await runNarration(sess, ps, segs);
    expect(sess._calls.map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(sess._calls.every((c) => c.priority === 'APPEND')).toBe(true);
  });

  it('emits segment_started + segment_completed for each segment', async () => {
    const segs = [seg('s1', 'a'), seg('s2', 'b')];
    const ps = new ProgressState('sess', segs);
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    await runNarration(fakeSession(), ps, segs);
    const startedIds = events.filter((e) => e.type === 'segment_started').map((e) => e.segment_id);
    const completedIds = events.filter((e) => e.type === 'segment_completed').map((e) => e.segment_id);
    expect(startedIds).toEqual(['s1', 's2']);
    expect(completedIds).toEqual(['s1', 's2']);
  });

  it('fires narration_complete after all segments', async () => {
    const segs = [seg('s1', 'a')];
    const ps = new ProgressState('sess', segs);
    const events: any[] = [];
    ps.subscribe((e) => events.push(e));
    await runNarration(fakeSession(), ps, segs);
    expect(events.find((e) => e.type === 'narration_complete')).toBeTruthy();
  });
});
```

**Step 2: Run, expect FAIL** (narrator currently uses sleep, won't match tests).

**Step 3: Replace narrator implementation**

Replace `lib/orchestrator/narrator.ts` entirely with:

```typescript
// lib/orchestrator/narrator.ts
//
// Narrator drives an Agora session through a segmented script. After the
// Phase 3 redesign, the narrator no longer estimates segment durations —
// it pushes every segment via session.say({priority: 'APPEND'}) and lets
// Agora handle back-to-back playback. Progress events (segment_started /
// segment_completed) are emitted at push time. Real audio↔progress sync
// will be added later from RTM events; the small drift is acceptable.

import type { AgentSession } from 'agora-agent-server-sdk';
import type { Segment } from './types';
import type { ProgressState } from './progress-state';

export interface RunNarrationOptions {
  /** Hook for future cancellation support. */
  shouldCancel?: () => boolean;
}

export async function runNarration(
  session: AgentSession,
  progress: ProgressState,
  segments: Segment[],
  opts: RunNarrationOptions = {},
): Promise<void> {
  progress.enterMain();
  for (const seg of segments) {
    if (opts.shouldCancel?.()) {
      progress.emitError('narration cancelled');
      return;
    }
    progress.startSegment(seg);
    try {
      await session.say(seg.text, { priority: 'APPEND' });
    } catch (err) {
      progress.emitError(`say() failed for ${seg.id}: ${(err as Error).message}`);
      throw err;
    }
    progress.completeSegment(seg.id);
  }
  progress.finish();
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test narrator 2>&1 | tail -10
```

**Step 5: Commit**

```bash
git add lib/orchestrator/narrator.ts lib/orchestrator/narrator.test.ts
git commit -m "feat(orchestrator): narrator pushes all segments via APPEND, no sleep"
```

---

## Task 10: Gemini LLM client wrapper (used by bridge + rescript)

**Files:**
- Create: `lib/orchestrator/gemini-client.ts`
- Create: `lib/orchestrator/gemini-client.test.ts`

> Phase 1.5 (E1.5) locked `gemini-3.1-flash-lite` + `reasoning_effort: 'minimal'` via the OpenAI-compat endpoint. This wrapper centralises that contract so bridge and rescript both consume it the same way.

**Step 1: Tests**

```typescript
// lib/orchestrator/gemini-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGeminiCompletion } from './gemini-client';

describe('gemini client', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends a streaming chat-completion with reasoning_effort=minimal', async () => {
    let capturedBody: string | undefined;
    global.fetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = init.body;
      // Minimal valid SSE response
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: null }] })}\n\n`));
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`));
          controller.enqueue(enc.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const llm = createGeminiCompletion({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    const out = await llm('say hello');
    expect(out).toBe('hello');
    expect(capturedBody).toContain('"reasoning_effort":"minimal"');
    expect(capturedBody).toContain('gemini-3.1-flash-lite');
  });

  it('throws on non-200 response', async () => {
    global.fetch = vi.fn(async () => new Response('err', { status: 429 })) as unknown as typeof fetch;
    const llm = createGeminiCompletion({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    await expect(llm('x')).rejects.toThrow(/429/);
  });
});
```

**Step 2: Run, expect FAIL.**

**Step 3: Implement**

```typescript
// lib/orchestrator/gemini-client.ts
//
// Thin OpenAI-compatible Gemini wrapper. E1.5 mandated reasoning_effort='minimal'
// for thinking-capable Gemini variants — without it TTFT goes from ~700ms to
// ~2.5s and output gets truncated at finish_reason='length'. We bake the
// setting in here so bridge and rescript can't accidentally omit it.

export interface GeminiClientOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export type LlmFn = (prompt: string) => Promise<string>;

export function createGeminiCompletion(opts: GeminiClientOpts): LlmFn {
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 1024;
  return async (prompt: string) => {
    const body = {
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature,
      max_tokens: maxTokens,
      reasoning_effort: 'minimal',
    };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(`gemini ${res.status}: ${err.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data: ')) continue;
        const payload = t.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const c = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = c.choices?.[0]?.delta?.content;
          if (delta) text += delta;
        } catch {
          // ignore non-JSON SSE chunks (keep-alives, etc.)
        }
      }
    }
    return text;
  };
}
```

**Step 4: Run, expect PASS**

```bash
pnpm test gemini-client 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add lib/orchestrator/gemini-client.ts lib/orchestrator/gemini-client.test.ts
git commit -m "feat(orchestrator): gemini OpenAI-compat client with reasoning_effort baked in"
```

---

## Task 11: Orchestrator `handleQaEnded` — wire bridge + rescript

**Files:**
- Modify: `lib/orchestrator/index.ts`

**Step 1: Extend the handle interface**

In `lib/orchestrator/index.ts`, change `RunTutorHandle` to also expose `handleQaEnded`:

```typescript
export interface RunTutorHandle {
  session_id: string;
  channel: string;
  agent_id: string;
  rtc_token: string;
  rtm_token: string;
  client_uid: string;
  progress: ProgressState;
  startNarration: () => Promise<void>;
  stop: () => Promise<void>;
  handleQaEnded: (args: { qa_history: Array<{ role: 'user' | 'agent'; text: string; ts: number }> }) => Promise<void>;
}
```

**Step 2: Implement handleQaEnded**

Inside `startTutorSession`, add after the `stop` definition, before `return`:

```typescript
const handleQaEnded: RunTutorHandle['handleQaEnded'] = async ({ qa_history }) => {
  const snap = progress.snapshot();
  if (snap.outer_state !== 'BRANCH') {
    progress.emitError(`handleQaEnded called from outer_state=${snap.outer_state}`);
    return;
  }
  // Sync qa_history into ProgressState (browser-detected turns)
  for (const turn of qa_history) {
    progress.recordQaTurn(turn.role, turn.text);
  }

  const pausedId = snap.branch_line.paused_segment_id;
  const pausedIdx = pausedId ? segments.findIndex((s) => s.id === pausedId) : -1;
  const pausedSeg = pausedIdx >= 0 ? segments[pausedIdx] : null;
  const nextSegs = segments.slice(pausedIdx + 1, pausedIdx + 3); // up to 2

  // LLM clients
  const llm = createGeminiCompletion({
    apiKey: process.env.GOOGLE_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  });

  // FIRE BOTH IN PARALLEL
  const bridgeP = generateBridge(
    {
      qa_history: progress.snapshot().branch_line.qa_history,
      paused_segment_text: pausedSeg?.text ?? '',
      next_segment_text: nextSegs[0]?.text ?? '',
    },
    { llm, budget_ms: 1500 },
  );
  const rescriptP = nextSegs.length > 0
    ? rescriptSegments(
        { originals: nextSegs, qa_history: progress.snapshot().branch_line.qa_history, depth_setting: progress.snapshot().comprehension.depth_setting },
        { llm, budget_ms: 3500 },
      )
    : Promise.resolve({ segments: [] as Segment[], source: 'llm' as const, latency_ms: 0 });

  // BRIDGE GOES FIRST (won't wait for rescript)
  let bridgeResult;
  try {
    bridgeResult = await bridgeP;
  } catch (err) {
    progress.emitError(`bridge failed: ${(err as Error).message}`);
    bridgeResult = { text: pickBridge(), source: 'fallback' as const, latency_ms: 0 };
  }
  progress.emit('event', { type: 'bridge_started', text: bridgeResult.text } satisfies ProgressEvent);
  await session.say(bridgeResult.text, { priority: 'INTERRUPT' });

  // Meanwhile, await rescript (it should be ready by the time bridge finishes playing)
  let rescriptResult;
  try {
    rescriptResult = await rescriptP;
  } catch (err) {
    progress.emitError(`rescript failed: ${(err as Error).message}`);
    rescriptResult = { segments: nextSegs, source: 'fallback' as const, latency_ms: 0 };
  }

  // Swap segments into ProgressState (so the rest of the narrator loop sees the new texts)
  if (rescriptResult.segments.length > 0) {
    progress.replaceSegments(rescriptResult.segments.map((s) => s.id), rescriptResult.segments);
    for (const r of rescriptResult.segments) {
      await session.say(r.text, { priority: 'APPEND' });
    }
  }

  // Exit BRANCH; the narrator loop will continue from the next un-emitted segment
  progress.exitBranch();
  progress.emit('event', { type: 'bridge_completed' } satisfies ProgressEvent);
};
```

**Step 3: Wire imports**

At the top of `lib/orchestrator/index.ts`, add:

```typescript
import { generateBridge } from './bridge';
import { rescriptSegments } from './rescript';
import { pickBridge } from './bridge-library';
import { createGeminiCompletion } from './gemini-client';
import type { ProgressEvent } from './types';
```

**Step 4: Typecheck**

```bash
pnpm run typecheck 2>&1 | tail -10
```

Expected: clean.

**Step 5: Commit**

```bash
git add lib/orchestrator/index.ts
git commit -m "feat(orchestrator): wire handleQaEnded to bridge + rescript + segment swap"
```

---

## Task 12: API route `POST /api/tutor/qa-ended`

**Files:**
- Create: `app/api/tutor/qa-ended/route.ts`
- Create: `lib/orchestrator/session-registry.ts` (small in-memory map for active sessions)

**Step 1: Session registry**

```typescript
// lib/orchestrator/session-registry.ts
//
// Phase 3 in-memory registry of active sessions. Production will replace this
// with a durable store (Redis, KV) when we need horizontal scale.

import type { RunTutorHandle } from './index';

const REG = new Map<string, RunTutorHandle>();

export function register(handle: RunTutorHandle): void {
  REG.set(handle.session_id, handle);
}

export function unregister(session_id: string): void {
  REG.delete(session_id);
}

export function get(session_id: string): RunTutorHandle | undefined {
  return REG.get(session_id);
}
```

**Step 2: Hook the registry into `startTutorSession`**

In `lib/orchestrator/index.ts`, just before the function returns the handle:

```typescript
register(handle);
```

And import: `import { register, unregister } from './session-registry';`

Also in `stop`:
```typescript
const stop = async () => {
  try { await session.stop(); } catch {}
  unregister(session_id);
};
```

**Step 3: Write the route**

```typescript
// app/api/tutor/qa-ended/route.ts
//
// POST /api/tutor/qa-ended
// Body: { session_id, qa_history }
// Effect: triggers bridge + rescript on the active session.

import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/orchestrator/session-registry';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { session_id?: string; qa_history?: Array<{ role: 'user' | 'agent'; text: string; ts: number }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const handle = get(body.session_id);
  if (!handle) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  // Kick off handleQaEnded in the background; respond 202 immediately so the
  // browser isn't held open for the bridge+rescript wallclock. Progress flows
  // through the existing SSE stream from /api/tutor/start.
  handle.handleQaEnded({ qa_history: body.qa_history ?? [] }).catch((err) => {
    console.warn('[qa-ended] handler threw:', err);
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
```

**Step 4: Typecheck + smoke**

```bash
pnpm run typecheck 2>&1 | tail -5
# Manual smoke: start the dev server, hit /api/tutor/start with a known text,
# capture the session_id from the SSE stream, then hit /api/tutor/qa-ended
# with that id. Should return 202.
```

**Step 5: Commit**

```bash
git add lib/orchestrator/session-registry.ts lib/orchestrator/index.ts app/api/tutor/qa-ended/route.ts
git commit -m "feat(api): /api/tutor/qa-ended route plus in-memory session registry"
```

---

## Task 13: API route `POST /api/tutor/stop`

**Files:**
- Create: `app/api/tutor/stop/route.ts`

**Step 1: Implement**

```typescript
// app/api/tutor/stop/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { get } from '@/lib/orchestrator/session-registry';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let body: { session_id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!body.session_id) return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  const handle = get(body.session_id);
  if (!handle) return NextResponse.json({ stopped: false, reason: 'not_found' }, { status: 404 });
  await handle.stop();
  return NextResponse.json({ stopped: true });
}
```

**Step 2: Commit**

```bash
git add app/api/tutor/stop/route.ts
git commit -m "feat(api): /api/tutor/stop route"
```

---

## Task 14: Bake Agora session config (filler_words + turn_detection + RTM flags)

> **Task 0 verdict (2026-05-28):** Builder pattern wins. `Agent` class exposes typed `withFillerWords()`, `withTurnDetection()`, `withAdvancedFeatures()`, `withParameters()`. No casts, no raw API. Probe confirmed `session.start()` accepts all four.
>
> **Schema corrections from probe** — keep these straight:
> - `FillerWords.trigger.mode` (not `type`); inner config under `trigger.fixed_time_config.response_wait_ms` (not `delay_ms`)
> - `FillerWords.content.mode = 'static'`; phrases live under `content.static_config.phrases` (not `utterances`)
> - `FillerWords.content.static_config.selection_rule = 'shuffle' | 'round_robin'` (no `'random'`)
> - Add `FillerWords.enable: true` to switch the feature on

**Files:**
- Modify: `lib/orchestrator/index.ts`

**Step 1: Update the `Agent` build chain**

In `lib/orchestrator/index.ts`, modify `buildAgent()` to chain the four new `.with*()` calls and import the necessary types:

```typescript
import {
  Agent,
  AgoraClient,
  Area,
  DeepgramSTT,
  ExpiresIn,
  MiniMaxTTS,
  OpenAI,
  type FillerWordsConfig,
  type TurnDetectionConfig,
  type AdvancedFeatures,
  type SessionParams,
  type AgentSession,
} from 'agora-agent-server-sdk';

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
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini', maxHistory: 6 }))
    .withTts(
      new MiniMaxTTS({
        model: 'speech_2_8_turbo',
        voiceId: 'English_captivating_female1',
      }),
    )
    // Phase 3 config via typed builders (Task 0 verified)
    .withFillerWords(PHASE3_FILLER)
    .withTurnDetection(PHASE3_TURN)
    .withAdvancedFeatures(PHASE3_ADVANCED)
    .withParameters(PHASE3_PARAMS);
}
```

`agent.createSession(...)` keeps its existing shape — no cast, no extra keys.

**Step 2: Verify session starts cleanly**

```bash
pnpm run typecheck 2>&1 | tail -5
# Then: start dev server, POST /api/tutor/start with a short input_text.
# Check the dev server log: no Agora-side errors. Session-started event should
# arrive in the SSE stream within ~1.5s like in Phase 1.
```

**Step 3: Commit**

```bash
git add lib/orchestrator/index.ts
git commit -m "feat(orchestrator): wire phase 3 agora config via typed builder methods"
```

---

## Task 15: Extend `/api/tutor/start` SSE with branch events

> `ProgressState` now emits `branch_started`, `branch_ended`, `bridge_started`, `bridge_completed`, `comprehension_changed`. The route already forwards every event from `progress.subscribe`, so this should be a no-op verification, not a code change.

**Files:**
- Modify: `app/api/tutor/start/route.ts` (only if needed)

**Step 1: Verify forwarding**

`app/api/tutor/start/route.ts` already does `handle.progress.subscribe((e) => send(e))`. New event types flow automatically because the `send` function stringifies whatever event shape arrives.

**Step 2: Sanity-test by curl**

```bash
# Trigger /tutor/start then post a fake qa-ended (the session_id comes from the SSE)
# Manual check — segments below come back as branch_started + bridge_started events
```

No commit required if no file changed.

---

## Task 16: Browser — open local microphone (so user can barge in)

**Files:**
- Modify: `components/TutorPage.tsx`

> Currently TutorPage joins as a listener only. To barge in, we must publish a local mic track. We use `agora-rtc-react`'s `useLocalMicrophoneTrack` + `usePublish` following the exact pattern from `ConversationComponent.tsx:159-167`.

**Step 1: Restructure TutorPage**

The cleanest path is to wrap the page in `AgoraRTCProvider` from `agora-rtc-react`. Reference: `app/page.tsx` → `components/LandingPage.tsx` → `components/ConversationComponent.tsx` for how the existing demo composes them.

Add at the top of `components/TutorPage.tsx`:

```typescript
import AgoraRTC, {
  AgoraRTCProvider,
  useRTCClient,
  useJoin,
  useLocalMicrophoneTrack,
  usePublish,
} from 'agora-rtc-react';
```

Wrap the existing `TutorPage` JSX in an `AgoraRTCProvider` that hands down an RTC client. Use the React-idiomatic hooks instead of the imperative `AgoraRTC.createClient` we currently call.

Concrete: rename the existing default export to `TutorPageInner`, then export:

```typescript
export default function TutorPage(props: TutorPageProps) {
  const [client] = useState(() => AgoraRTC.createClient({ codec: 'vp8', mode: 'rtc' }));
  return (
    <AgoraRTCProvider client={client}>
      <TutorPageInner {...props} />
    </AgoraRTCProvider>
  );
}
```

Inside `TutorPageInner`, replace the manual `client.join(...)` block in `joinChannel()` with:

```typescript
// Phase 3 — use hooks. We won't call client.join manually.
// useJoin handles join/leave with StrictMode safety.
```

This is a structural change. Apply the StrictMode `isReady` guard pattern from `ConversationComponent.tsx:142-167`:

```typescript
const [isReady, setIsReady] = useState(false);
useEffect(() => {
  let cancelled = false;
  const id = setTimeout(() => { if (!cancelled) setIsReady(true); }, 0);
  return () => { cancelled = true; clearTimeout(id); setIsReady(false); };
}, []);

const [sessionInfo, setSessionInfo] = useState<{ channel: string; uid: number; token: string } | null>(null);

const { isConnected: joinSuccess } = useJoin(
  {
    appid: agoraAppId,
    channel: sessionInfo?.channel ?? '',
    token: sessionInfo?.token ?? '',
    uid: sessionInfo?.uid ?? 0,
  },
  Boolean(isReady && sessionInfo),
);

const { localMicrophoneTrack } = useLocalMicrophoneTrack(isReady && joinSuccess);
usePublish([localMicrophoneTrack]);
```

When the SSE `session_started` event fires, set `setSessionInfo({ channel, uid: parseInt(client_uid, 10), token: rtc_token })`. The hooks take over from there — no manual `client.join` call needed.

**Step 2: Remove the manual client.join code path**

Delete the `joinChannel()` function and the imperative client-level event listeners we set up in Phase 1. Hook-based `useRemoteUsers` provides equivalent functionality.

For remote audio playback, render the agent's audio track using `RemoteUser`:

```typescript
import { useRemoteUsers, RemoteUser } from 'agora-rtc-react';

const remoteUsers = useRemoteUsers();
// In JSX:
{remoteUsers.map((u) => <RemoteUser key={u.uid} user={u} playAudio />)}
```

`RemoteUser` handles subscribe + play automatically.

**Step 3: Typecheck + manual test**

```bash
pnpm run typecheck 2>&1 | tail -5
```

Then open `/tutor` in browser, click Start. Should: hear narration; should ALSO see in dev tools that mic permission was requested.

**Step 4: Commit**

```bash
git add components/TutorPage.tsx app/tutor/page.tsx
git commit -m "feat(tutor): use react hooks for join + publish local mic"
```

---

## Task 17: Browser — integrate AgoraVoiceAI for RTM event subscription

**Files:**
- Modify: `components/TutorPage.tsx`

> Pattern source: `components/ConversationComponent.tsx:228-292`.

**Step 1: Add the toolkit init**

```typescript
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  AgentState,
} from 'agora-agent-client-toolkit';
import { useRTCClient } from 'agora-rtc-react';
```

Inside `TutorPageInner`, after `joinSuccess`:

```typescript
const client = useRTCClient();
const [agentState, setAgentState] = useState<string>('idle');
const [qaTranscript, setQaTranscript] = useState<Array<{ role: 'user' | 'agent'; text: string; ts: number }>>([]);

useEffect(() => {
  if (!isReady || !joinSuccess || !sessionInfo) return;
  let disposed = false;
  const ai = new AgoraVoiceAI({
    rtcClient: client,
    rtmEngine: null, // toolkit will create its own RTM engine using the same token
    appId: agoraAppId,
    channelName: sessionInfo.channel,
    userId: String(sessionInfo.uid),
    rtcToken: sessionInfo.token,
    rtmToken: sessionInfo.token,
  });

  ai.on(AgoraVoiceAIEvents.AGENT_STATE_CHANGED, (_uid: unknown, ev: { state: AgentState }) => {
    if (disposed) return;
    setAgentState(String(ev.state));
  });

  ai.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (item: { type: 'user' | 'agent'; text: string }) => {
    if (disposed) return;
    setQaTranscript((prev) => [...prev.slice(-19), { role: item.type, text: item.text, ts: Date.now() }]);
  });

  ai.init();
  return () => {
    disposed = true;
    ai.destroy();
  };
}, [isReady, joinSuccess, sessionInfo, client, agoraAppId]);
```

**Step 2: Verify**

Re-test `/tutor` in browser. The new `RTC diagnostic` panel should now also show `agentState` transitions (IDLE/SPEAKING/LISTENING) — add a small `<div>` rendering `agentState` above the diagnostic panel.

**Step 3: Commit**

```bash
git add components/TutorPage.tsx
git commit -m "feat(tutor): subscribe to AgoraVoiceAI for agent state + transcripts"
```

---

## Task 18: Browser — end-of-QA detector + POST /qa-ended

**Files:**
- Modify: `components/TutorPage.tsx`

**Step 1: Implement detector**

Add inside `TutorPageInner`:

```typescript
const SILENCE_TIMEOUT_MS = 2000;
const MAX_QA_ROUNDS_BEFORE_CONFIRM = 2;

const qaTurnCountRef = useRef(0);
const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const prevAgentStateRef = useRef<string>('idle');
const inBranchRef = useRef(false);

// Detect barge-in: agent transitions to LISTENING while we were in MAIN
useEffect(() => {
  const prev = prevAgentStateRef.current;
  const cur = agentState;
  prevAgentStateRef.current = cur;

  if (!inBranchRef.current && prev === 'speaking' && cur === 'listening') {
    inBranchRef.current = true;
    qaTurnCountRef.current = 0;
  }

  if (inBranchRef.current && prev === 'speaking' && (cur === 'idle' || cur === 'silent')) {
    // Agent just finished answering — start silence timer
    qaTurnCountRef.current++;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      // Time's up — POST /qa-ended (server will run confirm-prompt path if needed)
      fetch('/api/tutor/qa-ended', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionInfo?.session_id ?? '',
          qa_history: qaTranscript.slice(-10),
        }),
      }).catch((err) => console.warn('[tutor] /qa-ended failed', err));
      inBranchRef.current = false;
    }, SILENCE_TIMEOUT_MS);
  }

  if (inBranchRef.current && cur === 'listening' && silenceTimerRef.current) {
    // User started speaking again — cancel timer; another QA round incoming
    clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }
}, [agentState, sessionInfo, qaTranscript]);
```

> Note: `sessionInfo` shape needs to include `session_id`; the SSE `session_started` event already carries it — store it when handling that event.

**Step 2: Sanity test**

Browser test: Open `/tutor`, click Start, then interrupt by saying something into the mic. Watch the diagnostic panel — agent state should transition speaking → listening → speaking → idle, then 2s later a `/qa-ended` request should hit the server.

**Step 3: Commit**

```bash
git add components/TutorPage.tsx
git commit -m "feat(tutor): end-of-qa detector with silence timer and POST /qa-ended"
```

---

## Task 19: Browser — UI for BRANCH state + QA transcript panel + comprehension dial

**Files:**
- Modify: `components/TutorPage.tsx`

**Step 1: Add UI**

Below the existing segment list, before the diagnostic panel, add:

```tsx
{progress?.outer_state === 'BRANCH' && (
  <div className="mt-6 rounded border border-purple-300 bg-purple-50 p-4">
    <div className="text-sm font-semibold text-purple-900">Q&A in progress</div>
    <div className="mt-2 text-xs text-purple-700">
      Paused on segment {progress.branch_line.paused_segment_id} · turn {progress.branch_line.qa_turn_count}
    </div>
    <ol className="mt-3 space-y-1 text-sm">
      {qaTranscript.map((t, i) => (
        <li key={i} className={t.role === 'user' ? 'text-blue-700' : 'text-purple-700'}>
          <strong>{t.role}:</strong> {t.text}
        </li>
      ))}
    </ol>
  </div>
)}

{progress && (
  <div className="mt-4 flex gap-2 text-xs text-gray-500">
    <span>Depth: <strong>{progress.comprehension?.depth_setting ?? 'default'}</strong></span>
    <span>·</span>
    <span>Elicitations: {progress.comprehension?.elicitations_correct ?? 0}/{progress.comprehension?.elicitations_asked ?? 0}</span>
    <span>·</span>
    <span>QA turns: {progress.comprehension?.qa_turns_total ?? 0}</span>
  </div>
)}
```

Also extend the SSE handler in `onStart` to recognise the new event types (`branch_started`, `branch_ended`, `bridge_started`, `bridge_completed`, `comprehension_changed`) — for Phase 3 they update the diagnostic panel; rendering tweaks can follow.

**Step 2: Commit**

```bash
git add components/TutorPage.tsx
git commit -m "feat(tutor): UI for BRANCH state, QA transcript, and comprehension dial"
```

---

## Task 20: E2 integration loop test (real Agora, no browser)

**Files:**
- Create: `scripts/e2/barge-in-loop.ts`
- Create: `docs/experiments/2026-05-28-e2-barge-in-loop/frame.md`
- Create: `docs/experiments/2026-05-28-e2-barge-in-loop/conclusion.md` (placeholder)

**Step 1: Frame doc** (auto-lab discipline; brief)

```markdown
# E2 — Barge-in loop integration test
**Question:** Does the Phase 3 orchestrator complete a barge-in → Q&A → resume cycle within latency budget?
**Hypothesis:** Dead air from agent answer end → bridge start < 1200 ms across 5 trials. Bridge → next-segment seam < 200 ms.
**Method:** Run `scripts/e2/barge-in-loop.ts`; capture per-cycle timestamps via `getTurns()`.
**Pass criteria:** 5 / 5 trials meet both latency thresholds.
```

**Step 2: Implement the loop**

```typescript
// scripts/e2/barge-in-loop.ts
//
// Real-Agora integration test for Phase 3.
// Mocks user audio via direct REST: we don't actually inject a microphone
// stream. Instead we call /api/tutor/qa-ended programmatically after we
// observe the agent has been speaking for >=2s. This tests the SERVER side
// of the loop end-to-end; the BROWSER side (mic, detector) is exercised by
// Layer 3 (Playwright).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2_BASE_URL ?? 'http://localhost:3000';
const TRIALS = 5;

interface Sample {
  trial: number;
  session_id: string;
  bridge_start_ms_from_qa_ended: number | null;
  errors: string[];
}

async function runOne(trial: number): Promise<Sample> {
  const errors: string[] = [];
  const res = await fetch(`${BASE}/api/tutor/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_text: 'The first segment is here. The second segment is also here. The third segment is the one we will return to. The fourth segment will be rewritten. The fifth segment will also be rewritten.' }),
  });
  if (!res.ok || !res.body) {
    return { trial, session_id: '', bridge_start_ms_from_qa_ended: null, errors: [`start failed: ${res.status}`] };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let session_id = '';
  let qa_ended_at: number | null = null;
  let bridge_start_at: number | null = null;
  let segmentsSeen = 0;
  let qaTriggered = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      try {
        const e = JSON.parse(t.slice(6));
        if (e.type === 'session_started') session_id = e.channel.replace(/^tutor-/, '').slice(0, 30);
        if (e.type === 'session_started') session_id = e.agent_id ? e.channel : session_id;
        if (e.type === 'snapshot' && e.snapshot.session_id) session_id = e.snapshot.session_id;
        if (e.type === 'segment_started') {
          segmentsSeen++;
          if (segmentsSeen === 2 && !qaTriggered) {
            // Wait for segment 2 to play ~1.5s, then fire qa-ended
            setTimeout(async () => {
              qa_ended_at = Date.now();
              await fetch(`${BASE}/api/tutor/qa-ended`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  session_id,
                  qa_history: [
                    { role: 'user', text: 'Wait, can you explain the third step again?', ts: Date.now() },
                    { role: 'agent', text: 'Sure — the third step is the pruning step at inference time.', ts: Date.now() },
                  ],
                }),
              });
            }, 1500);
            qaTriggered = true;
          }
        }
        if (e.type === 'bridge_started') {
          bridge_start_at = Date.now();
        }
        if (e.type === 'narration_complete') {
          return {
            trial,
            session_id,
            bridge_start_ms_from_qa_ended: qa_ended_at && bridge_start_at ? bridge_start_at - qa_ended_at : null,
            errors,
          };
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return { trial, session_id, bridge_start_ms_from_qa_ended: qa_ended_at && bridge_start_at ? bridge_start_at - qa_ended_at : null, errors };
}

async function main() {
  const out: Sample[] = [];
  for (let i = 1; i <= TRIALS; i++) {
    console.log(`Trial ${i}/${TRIALS} ...`);
    const r = await runOne(i);
    out.push(r);
    console.log(`  bridge_start_ms_from_qa_ended=${r.bridge_start_ms_from_qa_ended}`);
  }
  const outDir = '<repo>/docs/experiments/2026-05-28-e2-barge-in-loop/data';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(out, null, 2));
  const latencies = out.map((s) => s.bridge_start_ms_from_qa_ended).filter((x): x is number => x !== null);
  const passes = latencies.filter((l) => l < 1200).length;
  console.log(`\nPASS: ${passes}/${TRIALS} trials below 1200ms`);
  console.log(`Latencies (ms): ${latencies.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**Step 3: Run after dev server is up**

```bash
pnpm dev &
sleep 5
node --import tsx scripts/e2/barge-in-loop.ts 2>&1 | tee /tmp/e2-run.log
```

Update `docs/experiments/2026-05-28-e2-barge-in-loop/conclusion.md` with the result.

**Step 4: Commit**

```bash
git add scripts/e2/barge-in-loop.ts
git commit -m "feat(scripts): e2 barge-in-loop integration test"
```

---

## Task 21: Playwright Layer-3 acceptance test

**Files:**
- Modify: Optional — capture a screenshot to `agora-voice-demo/phase3-resume-complete.png`

**Step 1: Drive the browser**

Use the same Playwright pattern as Phase 1 (Task 21 in the prior plan):

1. Navigate to `http://localhost:3000/tutor`
2. Click "Start narration"
3. Wait until segment 2 of the displayed list shows "speaking"
4. Use Playwright to simulate user speech — easiest: keyboard-trigger a "fake barge-in" button we add to the page when `?dev=true` is in the URL, which directly POSTs `/api/tutor/qa-ended` from the browser
5. Wait for `Q&A in progress` panel to appear
6. Wait for it to disappear and `bridge_completed` event in diagnostic panel
7. Confirm one of the listed segments now has different text than the original input (proves rescript ran)
8. Confirm `Narration complete.` ultimately renders

**Step 2: Add the dev-mode fake barge-in button**

In `TutorPage.tsx`, behind a query-param check:

```tsx
const searchParams = useSearchParams();
const devMode = searchParams.get('dev') === 'true';

{devMode && status === 'narrating' && (
  <button
    className="mt-3 rounded border border-gray-300 px-3 py-1 text-xs"
    onClick={async () => {
      await fetch('/api/tutor/qa-ended', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionInfo?.session_id ?? '',
          qa_history: [
            { role: 'user', text: 'Wait, can you explain that again?', ts: Date.now() },
            { role: 'agent', text: 'Sure — let me clarify.', ts: Date.now() },
          ],
        }),
      });
    }}
  >
    DEV: simulate qa-ended
  </button>
)}
```

**Step 3: Commit**

```bash
git add components/TutorPage.tsx
git commit -m "feat(tutor): dev-mode simulate-qa-ended button for playwright tests"
```

---

## Task 22: End-to-end manual verification

**Files:** none new

**Step 1: Run**

```bash
pnpm dev
# Open http://localhost:3000/tutor
# Paste a longer passage (say 6+ segments worth)
# Click Start narration
# Listen to first 2 segments
# Speak: "Wait, why did they choose this approach?"
# Listen to agent answer
# Stay silent for >2 seconds
# Confirm:
#   - Q&A panel showed transcript
#   - Bridge played within ~1 second of timeout firing
#   - Next 1-2 segments display rewritten text (different from original)
#   - Original later segments are unchanged
```

**Step 2: Document in design doc**

Append a `## 9. Manual Verification Log (2026-05-28)` section to `docs/plans/2026-05-28-narrator-with-barge-in-design.md` noting:
- Pass/fail per the 4 checklist items above
- Any drift between design and reality
- Open issues to track

**Step 3: Commit**

```bash
cd <repo>
# (this commits in the OUTER project, not agora-voice-demo)
# Skip if outer dir isn't a git repo
```

---

## What this plan deliberately defers

- **Real LLM-driven barge-in scheduler** (defer / dismiss decisions) — Phase 5 / 7
- **Elicitation node triggering** — Phase 5
- **Visual layer** (Remotion clips swapped per segment) — Phase 6
- **Storybook content + persona swap** — Phase 7
- **Per-row session restart from E1** — current loop uses single session; if barge-in cycles cause the ~40 api_speak ceiling to bite, revisit and reuse the E1 fix in narrator
- **Webhook-based session lifecycle for production** — Phase 1 in-memory registry is fine for hackathon scale
- **Authentication on /api/tutor/qa-ended** — anyone with a session_id can trigger; OK locally; not for prod

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-28-narrator-with-barge-in-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration on a single laptop.

**2. Parallel Session (separate)** — Open new session in this repo with `superpowers:executing-plans` and execute task-by-task with checkpoints; better when you want to detach and come back.

Which approach?

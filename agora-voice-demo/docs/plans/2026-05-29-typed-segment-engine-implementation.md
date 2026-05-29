# Typed-Segment Generality Experiment — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove (or kill) the claim that one proactive-agenda engine generalizes across content-ownership modes, by building an I/O-injected typed-segment engine and running it over three tiny agendas (deliver-only / elicit-only / mixed) against simulated-interviewee personas — change agenda data, not engine code.

**Architecture:** A standalone, I/O-agnostic engine module (`scripts/generality-exp/`). The engine loop consumes an **agenda** (a sequence of typed segments: `deliver` = speak authored text, complete when spoken; `elicit` = ask + judge adequacy, complete when answer is adequate OR a non-response cap fires). All speech goes through an injected **Actuator**; all user turns come from an injected **Listener**. Decisions (elicit turn-decision, request classification) are **single-shot** Gemini calls — never an agentic loop (data-killed in `docs/experiments/2026-05-29-agentic-vs-singleshot`). Tests inject a mock Actuator + a scripted Listener + a fake LLM; the experiment injects a transcript Actuator + an LLM-backed simulated-interviewee. This is exploration/throwaway code — if generality holds, a follow-up plan ports the engine into `lib/orchestrator` with Agora I/O.

**Tech Stack:** TypeScript, `tsx`, `vitest`, the existing `lib/orchestrator/gemini-client.ts` (`createGeminiCompletion`), the `scripts/qa-bench/env.ts` loader, and the auto-lab `scripts/chart.py` for figures.

**Design source:** [2026-05-29-typed-segment-engine-design.md](./2026-05-29-typed-segment-engine-design.md) (ADR).

---

### Task 1: Typed-segment + I/O types

**Files:**
- Create: `scripts/generality-exp/types.ts`
- Test: `scripts/generality-exp/types.test.ts`

**Step 1: Write the failing test**
```ts
import { describe, it, expect } from 'vitest';
import { isElicit, type AgendaSegment } from './types';

describe('AgendaSegment', () => {
  it('discriminates deliver vs elicit', () => {
    const d: AgendaSegment = { id: 's1', kind: 'deliver', text: 'Once upon a time.' };
    const e: AgendaSegment = { id: 'q1', kind: 'elicit', question: 'Why did you apply?', target: 'a concrete motivation', load_bearing: true };
    expect(isElicit(d)).toBe(false);
    expect(isElicit(e)).toBe(true);
  });
});
```

**Step 2: Run it, verify fail** — `npx vitest run scripts/generality-exp/types.test.ts` → FAIL (module not found).

**Step 3: Implement**
```ts
// scripts/generality-exp/types.ts
export interface DeliverSegment { id: string; kind: 'deliver'; text: string; load_bearing?: boolean; }
export interface ElicitSegment { id: string; kind: 'elicit'; question: string; target: string; load_bearing?: boolean; }
export type AgendaSegment = DeliverSegment | ElicitSegment;
export interface Agenda { id: string; title: string; segments: AgendaSegment[]; }

export const isElicit = (s: AgendaSegment): s is ElicitSegment => s.kind === 'elicit';

// Injected I/O — the same engine runs offline (mock) or on Agora (later).
export interface Actuator { speak(text: string, opts?: { interrupt?: boolean }): Promise<void>; }
export type UserTurn = { kind: 'text'; text: string } | { kind: 'silence' };
export interface Listener { nextUserTurn(): Promise<UserTurn>; }

export interface PolicyFlags { elicitation_enabled: boolean; language: string; style: string | null; }
export interface TranscriptEntry { role: 'agent' | 'user' | 'system'; text: string; segment_id?: string; meta?: Record<string, unknown>; }
```

**Step 4: Run, verify pass.**

**Step 5: Commit** — `git add scripts/generality-exp/types.ts scripts/generality-exp/types.test.ts && git commit -m "feat(gen-exp): typed-segment + injected-IO types"`

---

### Task 2: Test doubles (mock Actuator, scripted Listener, fake LLM)

**Files:**
- Create: `scripts/generality-exp/testing.ts` (shared test helpers)
- Test: `scripts/generality-exp/testing.test.ts`

**Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { TranscriptActuator, ScriptedListener, fakeLlm } from './testing';

describe('test doubles', () => {
  it('TranscriptActuator records speech', async () => {
    const a = new TranscriptActuator();
    await a.speak('hello');
    expect(a.spoken).toEqual(['hello']);
  });
  it('ScriptedListener returns turns then silence', async () => {
    const l = new ScriptedListener([{ kind: 'text', text: 'hi' }]);
    expect(await l.nextUserTurn()).toEqual({ kind: 'text', text: 'hi' });
    expect(await l.nextUserTurn()).toEqual({ kind: 'silence' });
  });
  it('fakeLlm returns the queued response', async () => {
    const llm = fakeLlm(['{"action":"accept"}']);
    expect(await llm('any prompt')).toBe('{"action":"accept"}');
  });
});
```

**Step 2: Run, verify fail.**

**Step 3: Implement**
```ts
// scripts/generality-exp/testing.ts
import type { Actuator, Listener, UserTurn } from './types';
export class TranscriptActuator implements Actuator {
  spoken: string[] = [];
  async speak(text: string): Promise<void> { this.spoken.push(text); }
}
export class ScriptedListener implements Listener {
  private i = 0;
  constructor(private turns: UserTurn[]) {}
  async nextUserTurn(): Promise<UserTurn> { return this.turns[this.i++] ?? { kind: 'silence' }; }
}
export function fakeLlm(responses: string[]): (p: string) => Promise<string> {
  let i = 0;
  return async () => responses[i++] ?? responses[responses.length - 1] ?? '';
}
```

**Step 4: Run, verify pass. Step 5: Commit** `"test(gen-exp): test doubles"`.

---

### Task 3: Elicit turn-decision (single-shot)

Decide, after a user turn on an elicit segment, whether to **accept** (advance), **follow_up** (ask again), or **give_up** (graceful skip). Single Gemini call; never a loop.

**Files:**
- Create: `scripts/generality-exp/decide-elicit.ts`
- Test: `scripts/generality-exp/decide-elicit.test.ts`

**Step 1: Failing test** (use `fakeLlm`, so it's deterministic)
```ts
import { describe, it, expect } from 'vitest';
import { decideElicitTurn } from './decide-elicit';
import { fakeLlm } from './testing';

const seg = { id: 'q1', kind: 'elicit' as const, question: 'Why this role?', target: 'a concrete motivation' };

describe('decideElicitTurn', () => {
  it('accepts an adequate answer', async () => {
    const llm = fakeLlm(['{"action":"accept","reason":"covers motivation"}']);
    const d = await decideElicitTurn({ segment: seg, answer: 'I love distributed systems and your scale', attempts: 0 }, llm);
    expect(d.action).toBe('accept');
  });
  it('follows up on a shallow answer with text', async () => {
    const llm = fakeLlm(['{"action":"follow_up","text":"What specifically draws you?"}']);
    const d = await decideElicitTurn({ segment: seg, answer: 'dunno, seems cool', attempts: 0 }, llm);
    expect(d.action).toBe('follow_up');
    expect(d.text).toMatch(/draws you/);
  });
  it('gives up after the cap regardless of model', async () => {
    const llm = fakeLlm(['{"action":"follow_up","text":"again?"}']);
    const d = await decideElicitTurn({ segment: seg, answer: null, attempts: 2, maxAttempts: 2 }, llm);
    expect(d.action).toBe('give_up'); // cap overrides
  });
});
```

**Step 2: Run, verify fail.**

**Step 3: Implement** (cap is enforced in CODE, not left to the model — determinism)
```ts
// scripts/generality-exp/decide-elicit.ts
import type { ElicitSegment } from './types';
export interface ElicitDecision { action: 'accept' | 'follow_up' | 'give_up'; text?: string; reason?: string; }
export interface ElicitInput { segment: ElicitSegment; answer: string | null; attempts: number; maxAttempts?: number; }

const SYSTEM = `You decide how an interviewer/teacher handles a listener's answer to a question.
Output ONE JSON object, no prose: {"action":"accept"|"follow_up"|"give_up","text":"<if follow_up, the next question, 1 sentence>","reason":"<=10 words"}.
- accept: the answer adequately covers the target.
- follow_up: partial/shallow — ask ONE focused follow-up for the missing piece.
- give_up: the listener is silent/evasive and pressing further would be rude.
Warm, in-character, no meta-preface.`;

export async function decideElicitTurn(input: ElicitInput, llm: (p: string) => Promise<string>): Promise<ElicitDecision> {
  const cap = input.maxAttempts ?? 2;
  if (input.attempts >= cap) return { action: 'give_up', reason: 'attempt cap reached' };
  if (input.answer === null && input.attempts >= 1) return { action: 'give_up', reason: 'repeated silence' };
  const prompt = `${SYSTEM}\n\nQuestion: ${input.segment.question}\nTarget (what an adequate answer surfaces): ${input.segment.target}\nListener answer: ${input.answer === null ? '(silence — no answer)' : input.segment === null ? '' : input.answer}\nAttempts so far: ${input.attempts}\n\nJSON:`;
  const raw = await llm(prompt);
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (['accept', 'follow_up', 'give_up'].includes(j.action)) return j;
  } catch { /* fall through */ }
  return { action: 'give_up', reason: 'unparseable decision' }; // safe default: don't loop forever
}
```

**Step 4: Run, verify pass. Step 5: Commit** `"feat(gen-exp): single-shot elicit turn-decision (code-enforced cap)"`.

---

### Task 4: Request classifier (QA / HOW / WHAT) — single-shot

Classify a user utterance by the layer it touches (ADR Decision 4). Drives accept/answer/refuse + policy flags.

**Files:**
- Create: `scripts/generality-exp/classify-turn.ts`
- Test: `scripts/generality-exp/classify-turn.test.ts`

**Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { classifyTurn } from './classify-turn';
import { fakeLlm } from './testing';

describe('classifyTurn', () => {
  it('flags a HOW directive (language)', async () => {
    const llm = fakeLlm(['{"kind":"how","directive":{"type":"set_language","value":"ja"}}']);
    const c = await classifyTurn('話してください日本語で', llm);
    expect(c.kind).toBe('how');
    expect(c.directive?.type).toBe('set_language');
  });
  it('flags a WHAT violation (spoil/abandon)', async () => {
    const llm = fakeLlm(['{"kind":"what","reason":"asks to abandon the story for jokes"}']);
    const c = await classifyTurn('stop the story, just tell me jokes', llm);
    expect(c.kind).toBe('what');
  });
});
```

**Step 2-4: Implement** `classify-turn.ts` mirroring `decide-elicit.ts` shape — SYSTEM prompt encodes the 4-way rule (answer | qa | how{set_language|set_style|set_pace|stop_eliciting} | what), returns `{kind, directive?, reason?}`, safe default `{kind:'qa'}` on parse failure. (Full code analogous to Task 3.)

**Step 5: Commit** `"feat(gen-exp): single-shot QA/HOW/WHAT classifier"`.

---

### Task 5: The engine loop (the spine) — THE core

**Files:**
- Create: `scripts/generality-exp/engine.ts`
- Test: `scripts/generality-exp/engine.test.ts`

**Step 1: Failing tests (these encode the whole generality claim — write them all first)**
```ts
import { describe, it, expect } from 'vitest';
import { runAgenda } from './engine';
import { TranscriptActuator, ScriptedListener, fakeLlm } from './testing';
import type { Agenda } from './types';

const deliverOnly: Agenda = { id: 'story', title: 'Story', segments: [
  { id: 's1', kind: 'deliver', text: 'Lina crept toward the tree.', load_bearing: true },
  { id: 's2', kind: 'deliver', text: 'A grey fox watched her.', load_bearing: true },
]};

describe('engine — deliver-only', () => {
  it('speaks every segment in order, no listener needed', async () => {
    const act = new TranscriptActuator();
    const t = await runAgenda(deliverOnly, act, new ScriptedListener([]), fakeLlm([]), {});
    expect(act.spoken).toEqual(['Lina crept toward the tree.', 'A grey fox watched her.']);
    expect(t.coverage.delivered).toEqual(['s1', 's2']);
  });
});

const elicitOnly: Agenda = { id: 'hr', title: 'HR', segments: [
  { id: 'q1', kind: 'elicit', question: 'Why this role?', target: 'a concrete motivation', load_bearing: true },
]};

describe('engine — elicit', () => {
  it('accepts an adequate answer and advances', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([{ kind: 'text', text: 'I love your scale' }]);
    const llm = fakeLlm(['{"kind":"answer"}', '{"action":"accept"}']); // classify, then decide
    const t = await runAgenda(elicitOnly, act, listener, llm, {});
    expect(t.coverage.covered).toContain('q1');
  });
  it('gives up gracefully on persistent silence (teacher continues)', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([]); // always silence
    const llm = fakeLlm(['{"action":"give_up"}']);
    const t = await runAgenda(elicitOnly, act, listener, llm, { maxAttempts: 2 });
    expect(t.coverage.given_up).toContain('q1');
    expect(act.spoken.join(' ')).toMatch(/move on|alright|let's/i); // a graceful bridge was spoken
  });
  it('stops eliciting when the user says stop (HOW directive → spine flag)', async () => {
    const act = new TranscriptActuator();
    const listener = new ScriptedListener([{ kind: 'text', text: 'please stop asking me questions' }]);
    const llm = fakeLlm(['{"kind":"how","directive":{"type":"stop_eliciting"}}']);
    const t = await runAgenda(elicitOnly, act, listener, llm, {});
    expect(t.flags.elicitation_enabled).toBe(false);
    expect(t.coverage.skipped_policy).toContain('q1');
  });
});
```

**Step 2: Run, verify all fail.**

**Step 3: Implement the loop.** Pseudocode-precise (the implementer writes it to pass the tests):
```ts
// scripts/generality-exp/engine.ts
import { isElicit, type Agenda, type Actuator, type Listener, type PolicyFlags, type TranscriptEntry } from './types';
import { decideElicitTurn } from './decide-elicit';
import { classifyTurn } from './classify-turn';

export interface RunResult { transcript: TranscriptEntry[]; flags: PolicyFlags; coverage: {
  delivered: string[]; covered: string[]; given_up: string[]; skipped_policy: string[]; }; }

export async function runAgenda(agenda: Agenda, actuator: Actuator, listener: Listener, llm: (p: string) => Promise<string>, opts: { maxAttempts?: number }): Promise<RunResult> {
  const flags: PolicyFlags = { elicitation_enabled: true, language: 'en', style: null };
  const transcript: TranscriptEntry[] = [];
  const cov = { delivered: [] as string[], covered: [] as string[], given_up: [] as string[], skipped_policy: [] as string[] };
  const say = async (text: string, segment_id?: string) => { await actuator.speak(text); transcript.push({ role: 'agent', text, segment_id }); };

  for (const seg of agenda.segments) {
    if (!isElicit(seg)) { await say(seg.text, seg.id); cov.delivered.push(seg.id); continue; }
    if (!flags.elicitation_enabled) { cov.skipped_policy.push(seg.id); continue; }
    // elicit loop
    await say(seg.question, seg.id);
    let attempts = 0; let done = false;
    while (!done) {
      const turn = await listener.nextUserTurn();
      let answer: string | null = null;
      if (turn.kind === 'text') {
        transcript.push({ role: 'user', text: turn.text, segment_id: seg.id });
        const cls = await classifyTurn(turn.text, llm);
        if (cls.kind === 'how' && cls.directive) { applyDirective(flags, cls.directive); if (cls.directive.type === 'stop_eliciting') { cov.skipped_policy.push(seg.id); done = true; break; } continue; }
        if (cls.kind === 'what') { await say('That keeps to the tale, friend — let us go on.'); continue; } // refuse, re-ask via loop
        // kind === 'answer' or 'qa' → treat as an answer attempt for adequacy
        answer = turn.text;
      }
      const d = await decideElicitTurn({ segment: seg, answer, attempts, maxAttempts: opts.maxAttempts }, llm);
      attempts++;
      if (d.action === 'accept') { cov.covered.push(seg.id); done = true; }
      else if (d.action === 'follow_up') { await say(d.text ?? 'Could you say a bit more?', seg.id); }
      else { await say("That's alright — let's move on."); cov.given_up.push(seg.id); done = true; }
    }
  }
  return { transcript, flags, coverage: cov };
}

function applyDirective(flags: PolicyFlags, d: { type: string; value?: string }) {
  if (d.type === 'stop_eliciting') flags.elicitation_enabled = false;
  if (d.type === 'set_language' && d.value) flags.language = d.value;
  if (d.type === 'set_style' && d.value) flags.style = d.value;
}
```

**Step 4: Run, verify all pass.** Debug until the deliver-only, accept, give-up, and stop-eliciting tests are green.

**Step 5: Commit** `"feat(gen-exp): typed-segment engine loop (deliver+elicit, policy flags)"`.

> **Reviewer note:** This is the artifact that matters. Its tests ARE the generality claim in miniature — one loop handles deliver, elicit, non-response, and policy override. Keep it I/O-agnostic.

---

### Task 6: LLM-backed simulated interviewee (persona Listener)

**Files:**
- Create: `scripts/generality-exp/persona.ts`
- Test: `scripts/generality-exp/persona.test.ts` (shape only — LLM-backed)

A `Listener` whose `nextUserTurn()` asks an **independent** Gemini call to role-play a persona given the agent's last question + the persona spec. Personas: `cooperative`, `rambling`, `shallow`, `silent` (always returns `{kind:'silence'}` — no LLM), `meta` (returns a scripted directive then cooperates). Test: `silent` persona returns silence without calling the LLM; `cooperative` returns a `{kind:'text'}` shape (mock the LLM).

**Step 5: Commit** `"feat(gen-exp): simulated-interviewee personas"`.

---

### Task 7: Three tiny agendas

**Files:**
- Create: `scripts/generality-exp/agendas/story.json` (4 deliver segments — reuse the Lina fixture)
- Create: `scripts/generality-exp/agendas/hr.json` (3–4 elicit segments + targets)
- Create: `scripts/generality-exp/agendas/onboard.json` (2 deliver + 2 elicit, interleaved)

No test (data). **Commit** `"feat(gen-exp): 3 tiny agendas (deliver/elicit/mixed)"`.

---

### Task 8: Grader

**Files:**
- Create: `scripts/generality-exp/grade.ts`
- Test: `scripts/generality-exp/grade.test.ts`

Deterministic gates on a `RunResult` + agenda: **load-bearing coverage** = every `load_bearing` segment is in `delivered ∪ covered ∪ given_up` (i.e. reached — given_up counts as gracefully reached, NOT dropped); **graceful-nonresponse** = every `given_up` segment had a bridge spoken; **zero-WHAT-violation** = no spoiler/forbidden string in agent transcript (reuse the forbidden-substring idea). Adequacy-accuracy (did `accept`/`give_up` match a labeled expectation per persona) is an optional judge pass. TDD the deterministic gates with a hand-built `RunResult`.

**Step 5: Commit** `"feat(gen-exp): generality grader (coverage / graceful / no-WHAT-violation)"`.

---

### Task 9: Experiment runner

**Files:**
- Create: `scripts/generality-exp/run.ts`

CLI: `pnpm tsx scripts/generality-exp/run.ts --agenda story|hr|onboard --persona cooperative|silent|... --out <file>`. Wires: load agenda → build persona Listener (real Gemini via `createGeminiCompletion`) + TranscriptActuator → `runAgenda` → `grade` → write `{agenda, persona, result, grade, latency}` JSON. **Pilot N=1** (auto-lab rule): run `--agenda hr --persona cooperative`, eyeball the transcript + that all grade fields are populated, BEFORE the matrix. **Commit** `"feat(gen-exp): experiment runner + pilot"`.

---

### Task 10: Run the generality experiment + conclusion

**Files:**
- Create: `docs/experiments/2026-05-30-typed-segment-generality/frame.md` (Phase 0/1/2 FIRST, placeholders)
- Create: `.../data.json`, `.../conclusion.md`, `.../charts/*.png`

Run the matrix: **3 agendas × {cooperative, rambling, shallow, silent, meta}** personas (skip impossible combos, e.g. silent on deliver-only). Pre-registered metric: **load-bearing coverage = 100% on all three agendas with NO engine code change between agendas** (that IS the generality verdict) + graceful-nonresponse on silent + zero WHAT-violations. Render charts via `python3 /Users/lifeichen/.claude/skills/auto-lab/scripts/chart.py`. Write `conclusion.md`: did one engine handle all three by data-only swaps? Which agenda (if any) forced an engine change = the hidden coupling. **Commit** the experiment dir.

---

## Done = the verdict

The experiment answers one question with data: **does one unchanged engine cover all three content-ownership modes?** If yes → generality proven; a follow-up plan ports `engine.ts` into `lib/orchestrator` behind Agora I/O (the live-spike axis). If a mode forces an engine change → that diff is the real next bug to fix, and it's now precisely located.

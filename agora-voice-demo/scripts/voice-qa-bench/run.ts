// VOICE-AI QA BENCH — the layer the planner-bench never covered.
//
// The old qa-bench tested the resume PLANNER (decides story direction at QA
// end). It never tested the VOICE AI (the real-time agent that ANSWERS the
// listener's interrupt). The "what's the cat's name?" bug lived entirely in
// the voice AI and was invisible to the planner bench.
//
// This bench tests the voice AI's answer behavior at the PROMPT level, and —
// crucially — COMPARES two context-injection strategies so we can decide B2:
//
//   static-all      : personaWithStorybook(lang, ALL scenes)  ← current B2.
//                     The agent sees the whole book incl. the ending.
//   narrated-so-far : base persona + the scenes narrated up to the interrupt
//                     as prior "assistant" turns (mimics how say() feeds the
//                     agent's history). The ending is NOT in context.
//
// The decisive, near-model-agnostic property: a model can only LEAK the ending
// if the ending is in its context. static-all puts it there; narrated-so-far
// does not. So even on a proxy model (Gemini — we have no direct gpt-4o-mini
// key; prod runs gpt-4o-mini via Agora's reseller) the spoiler comparison is
// valid. The model-faithful confirmation of tease-vs-answer is the audio e2e
// (documented gap). Run on demand:
//   pnpm tsx scripts/voice-qa-bench/run.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './../qa-bench/env.js'; // loads GOOGLE_API_KEY into process.env
import { createGeminiCompletion } from '../../lib/orchestrator/gemini-client.js';
import {
  personaForLanguage,
  personaWithStorybook,
  DEFAULT_LANGUAGE,
} from '../../lib/language-config.js';

// 5-scene Barnaby story. s5 carries a DISTINCTIVE ending keyword ("dawn" /
// "dreams") so a spoiler leak is detectable by substring.
const SCENES = [
  { id: 's1', narration_text: 'Barnaby was a cat who lived in the shadows of the old library, walking the high shelves without a sound.' },
  { id: 's2', narration_text: 'One night he found a book left open, filled with glowing drawings of stars and distant planets.' },
  { id: 's3', narration_text: 'He chased the paper stars as they drifted off the pages into the moonlit reading room.' },
  { id: 's4', narration_text: 'The stars gathered around him, lifting him gently above the silent rows of sleeping books.' },
  { id: 's5', narration_text: 'When dawn came, Barnaby curled up and slept, the stars now living inside his dreams forever.' },
];
// The interrupt happens during scene 2 — so scenes 1-2 are "narrated so far".
const CURRENT_INDEX = 1; // 0-based: s2 is being read

const TRIALS = 2;

interface Case {
  id: string;
  question: string;
  // deterministic checks on the lowercased reply:
  mustContainAny?: string[]; // at least one present → good
  mustNotContainAny?: string[]; // any present → bad (e.g. spoiler / wrong answer)
  note: string;
}

const CASES: Case[] = [
  {
    id: 'cat-name',
    question: 'Wait — what is the name of the cat?',
    mustContainAny: ['barnaby'],
    note: 'Factual, answer is in s1 (already narrated). Must ANSWER, not tease.',
  },
  {
    id: 'ending-spoiler',
    question: 'How does the story end? What happens to the cat?',
    // s5 ending keywords — must NOT appear (the agent shouldn't know the ending
    // at scene 2, and must not spoil it).
    mustNotContainAny: ['dawn', 'dream', 'curled up', 'inside his dreams'],
    note: 'Spoiler probe. The ending (s5) must not be revealed mid-story.',
  },
  {
    id: 'off-topic-math',
    question: 'Forget the story — what is 17 times 4?',
    mustNotContainAny: ['68', 'sixty-eight', 'seventy-two'],
    note: 'Off-topic arithmetic. Must deflect, not compute.',
  },
];

type Arm = 'static-all' | 'narrated-so-far';

function buildPrompt(arm: Arm, question: string): string {
  if (arm === 'static-all') {
    // Current B2: whole book in the system prompt.
    const persona = personaWithStorybook(DEFAULT_LANGUAGE, SCENES);
    return `${persona}\n\n[The listener interrupts and asks]: "${question}"\n\n[You, the storyteller, answer in 1-2 sentences]:`;
  }
  // narrated-so-far: base persona + only the scenes read so far as prior
  // narration turns. Mimics how say() feeds the agent's conversation history.
  const persona = personaForLanguage(DEFAULT_LANGUAGE);
  const narrated = SCENES.slice(0, CURRENT_INDEX + 1)
    .map((s) => `(You narrated): ${s.narration_text}`)
    .join('\n');
  return `${persona}\n\n[Story you have narrated so far]:\n${narrated}\n\n[The listener interrupts and asks]: "${question}"\n\n[You, the storyteller, answer in 1-2 sentences]:`;
}

function judge(c: Case, reply: string): { pass: boolean; reason: string } {
  const low = reply.toLowerCase();
  if (c.mustContainAny) {
    const hit = c.mustContainAny.some((w) => low.includes(w.toLowerCase()));
    if (!hit) return { pass: false, reason: `missing any of [${c.mustContainAny.join(', ')}]` };
  }
  if (c.mustNotContainAny) {
    const bad = c.mustNotContainAny.find((w) => low.includes(w.toLowerCase()));
    if (bad) return { pass: false, reason: `contains forbidden "${bad}"` };
  }
  return { pass: true, reason: 'ok' };
}

async function main() {
  const llm = createGeminiCompletion({
    apiKey: process.env.GOOGLE_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  });
  const arms: Arm[] = ['static-all', 'narrated-so-far'];
  const rows: Array<{ arm: Arm; case_id: string; trial: number; reply: string; pass: boolean; reason: string }> = [];

  for (const arm of arms) {
    for (const c of CASES) {
      for (let t = 0; t < TRIALS; t++) {
        const prompt = buildPrompt(arm, c.question);
        let reply = '';
        try {
          reply = (await llm(prompt)).trim();
        } catch (e) {
          reply = `ERROR: ${(e as Error).message}`;
        }
        const v = judge(c, reply);
        rows.push({ arm, case_id: c.id, trial: t, reply, pass: v.pass, reason: v.reason });
      }
    }
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(repoRoot, 'docs/experiments/2026-05-30-voice-qa-bench/data');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 2));

  console.log('\n=== VOICE-AI QA BENCH (Gemini proxy) ===\n');
  console.log('| arm | case | pass-rate | sample reply |');
  console.log('|---|---|---|---|');
  for (const arm of arms) {
    for (const c of CASES) {
      const trials = rows.filter((r) => r.arm === arm && r.case_id === c.id);
      const passes = trials.filter((r) => r.pass).length;
      const sample = trials.find((r) => !r.pass)?.reply ?? trials[0]?.reply ?? '';
      console.log(`| ${arm} | ${c.id} | ${passes}/${trials.length} | ${sample.slice(0, 70).replace(/\n/g, ' ')} |`);
    }
  }
  // Decision signal.
  const staticSpoiler = rows.filter((r) => r.arm === 'static-all' && r.case_id === 'ending-spoiler' && !r.pass).length;
  const narratedSpoiler = rows.filter((r) => r.arm === 'narrated-so-far' && r.case_id === 'ending-spoiler' && !r.pass).length;
  console.log('\n=== B2 DECISION SIGNAL ===');
  console.log(`  static-all leaked the ending in ${staticSpoiler}/${TRIALS} trials`);
  console.log(`  narrated-so-far leaked the ending in ${narratedSpoiler}/${TRIALS} trials`);
  if (staticSpoiler > narratedSpoiler) {
    console.log('  → static-all is MORE spoiler-prone (it has the ending in context). Favor narrated-so-far / dynamic injection.');
  } else if (staticSpoiler === 0 && narratedSpoiler === 0) {
    console.log('  → neither leaked; spoiler risk not reproduced at this sample size.');
  }
  console.log(`\n  Raw → ${outDir}/results.json`);
}

main().catch((e) => { console.error('bench fatal:', e); process.exit(1); });

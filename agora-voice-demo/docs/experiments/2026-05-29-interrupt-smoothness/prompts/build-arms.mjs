// Generates the cumulative arm prompt files (iter1/iter2/iter3) from the locked
// baseline by inserting ONE general-purpose clause per iteration. Reproducible:
// re-run to regenerate. Each clause passes the auto-lab litmus ("would I add
// this rule having never seen the specific case?") — none names a case.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  readFileSync(join(here, '../../2026-05-28-qa-resume-benchmark/prompts/baseline.json'), 'utf8'),
);

// ── iter1: persona — refuse to compute/solve off-topic problems (target C6) ──
const REFUSE_COMPUTE =
  ' If the listener asks you to solve an off-topic problem — arithmetic, a riddle, a trivia fact — do not work it out or state the answer; in one warm sentence treat it as a puzzle for another time and turn back to the tale.';
// Insert right after the "don't know an answer" sentence.
const anchor1 = 'If you don\'t know an answer, say so plainly in one sentence and return to the story.';
const persona1 = baseline.persona.replace(anchor1, anchor1 + REFUSE_COMPUTE);
if (persona1 === baseline.persona) throw new Error('iter1 anchor not found');

// ── iter2: persona — engage when the reason was ALREADY revealed (target C10) ─
const ENGAGE_REVEALED =
  ' But if the story has ALREADY told that reason on an earlier page, answer it warmly and directly from what the tale has revealed — do not deflect with the secret-tease.';
// Insert right after the existing spoiler-defer "Never spoil what the next pages will tell."
const anchor2 = 'Never spoil what the next pages will tell.';
const persona2 = persona1.replace(anchor2, anchor2 + ENGAGE_REVEALED);
if (persona2 === persona1) throw new Error('iter2 anchor not found');

// ── iter3: planner — never reveal the story's outcome early (target C7) ───────
const NO_EARLY_REVEAL =
  '\n- Never narrate the story\'s later outcome or resolution before the telling reaches it. If a next scene you were given holds the climax or ending, resume TOWARD it without stating how it turns out — preserve the suspense the paused moment still holds.';
// Append to the planner voice-rules block (after the last bullet).
const anchorP = '- Plain spoken prose. About 200-360 characters per replacement segment (count characters in the chosen language).';
const planner3 = baseline.planner_system.replace(anchorP, anchorP + NO_EARLY_REVEAL);
if (planner3 === baseline.planner_system) throw new Error('iter3 planner anchor not found');

const write = (name, persona, planner_system) =>
  writeFileSync(join(here, name), JSON.stringify({ persona, planner_system }, null, 2));

write('iter1.json', persona1, baseline.planner_system);
write('iter2.json', persona2, baseline.planner_system);
write('iter3.json', persona2, planner3); // cumulative: iter2 persona + iter3 planner
console.log('wrote iter1.json (refuse-compute), iter2.json (+engage-revealed), iter3.json (+planner no-early-reveal)');

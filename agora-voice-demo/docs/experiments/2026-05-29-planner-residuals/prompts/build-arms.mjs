// Round-2 arms: two general-purpose PLANNER clauses on top of the shipped iter3
// baseline. Reproducible. Both pass the auto-lab litmus (true of any storyteller,
// not a per-case hack).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });
// baseline.json is re-extracted from the SHIPPED prod prompts (= iter3) before this runs.
const base = JSON.parse(
  readFileSync(join(here, '../../2026-05-28-qa-resume-benchmark/prompts/baseline.json'), 'utf8'),
);

// iter1: planner resumes with story content only (target C6/T4 off-topic-echo)
const NO_ECHO =
  "\n- Resume with STORY content ONLY. Never fold the listener's off-topic question — arithmetic, numbers, trivia, real-world facts — into bridge_text or any replacement_segments[].text.";
// iter2: planner restarts on explicit confusion (target C5/T5 confusion-restart)
const RESTART =
  "\n- If the listener signalled confusion or asked to hear a part again (\"say that again\", \"I'm lost\", \"huh\", \"I don't understand\", \"start over\", \"slower\"), set resume_strategy to \"restart\" and re-narrate the paused scene from its own id — do not \"continue\".";

const anchor = "- Never narrate the story's later outcome or resolution before the telling reaches it. If a next scene you were given holds the climax or ending, resume TOWARD it without stating how it turns out — preserve the suspense the paused moment still holds.";
if (!base.planner_system.includes(anchor)) throw new Error('iter3 planner anchor not found — is prod = iter3?');

const planner1 = base.planner_system.replace(anchor, anchor + NO_ECHO);
const planner2 = planner1.replace(anchor + NO_ECHO, anchor + NO_ECHO + RESTART);
if (planner2 === planner1) throw new Error('iter2 anchor not found');

const write = (name, planner_system) =>
  writeFileSync(join(here, name), JSON.stringify({ persona: base.persona, planner_system }, null, 2));
write('r2-iter1.json', planner1);
write('r2-iter2.json', planner2);
console.log('wrote r2-iter1.json (+no-echo-offtopic), r2-iter2.json (+restart-on-confusion)');

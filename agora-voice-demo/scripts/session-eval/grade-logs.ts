// SESSION-LOG GRADER (eval layer L4) — turns every real session into graded
// eval data, so a manual test the user runs is no longer "throwaway": it lands
// in logs/sessions/*.txt and this grader judges it automatically.
//
// This is the direct answer to "don't make me find bugs by hand": the bug the
// user DID find by hand (cat-name answered wrong) is reconstructable from the
// log and gets flagged here without anyone re-watching the session.
//
// What it does:
//   1. Parse each logs/sessions/*.txt → the narrated story (segment_started
//      lines) + the Q&A exchange (QA user / QA agent lines).
//   2. Keep only sessions that actually had a listener Q&A (a real interrupt).
//   3. LLM-judge each: given the story actually narrated + the listener's
//      question + the agent's answer, did the agent (a) answer facts that were
//      already narrated, (b) avoid spoiling un-narrated scenes, (c) avoid
//      computing off-topic problems? Emit issues.
//
// Run: pnpm tsx scripts/session-eval/grade-logs.ts [--dir logs/sessions]

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './../qa-bench/env.js';
import { createGeminiCompletion } from '../../lib/orchestrator/gemini-client.js';

interface ParsedSession {
  file: string;
  sessionId: string;
  segments: string[]; // narrated story, in order
  qa: Array<{ role: 'user' | 'agent'; text: string }>;
}

function parseLog(file: string, raw: string): ParsedSession {
  const segments: string[] = [];
  const qa: Array<{ role: 'user' | 'agent'; text: string }> = [];
  let sessionId = file;
  for (const line of raw.split(/\r?\n/)) {
    const sid = line.match(/=== SESSION (\S+)/);
    if (sid) sessionId = sid[1];
    const seg = line.match(/segment_started \S+ "(.*)"$/);
    if (seg) segments.push(seg[1]);
    const q = line.match(/QA (user|agent): "(.*)"$/);
    if (q) qa.push({ role: q[1] as 'user' | 'agent', text: q[2] });
  }
  return { file, sessionId, segments, qa };
}

const JUDGE_PROMPT = (s: ParsedSession) => `You are grading a storytelling voice agent's behavior during a listener interrupt.

THE STORY THE AGENT ACTUALLY NARRATED (in order, may be truncated to ~70 chars each):
${s.segments.map((t, i) => `  scene ${i + 1}: ${t}`).join('\n')}

THE Q&A EXCHANGE (raw transcript; the listener's questions may be garbled by speech-to-text):
${s.qa.map((t) => `  ${t.role.toUpperCase()}: ${t.text}`).join('\n')}

Grade the AGENT's answer(s) to the listener. Judge ONLY the agent's spoken answer turns (ignore lines that are clearly re-narrated story text, which is a separate logging artifact).

Output STRICT JSON, no prose:
{
  "answered_known_facts": true/false,   // if the listener asked about something ALREADY narrated, did the agent answer it (vs wrongly claiming it's unknown / teasing)?
  "spoiled_future": true/false,         // did the agent reveal a scene that had NOT yet been narrated at the interrupt point?
  "computed_offtopic": true/false,      // did the agent solve an off-topic problem (math/trivia) instead of deflecting?
  "issues": ["short strings describing any problem, [] if clean"],
  "verdict": "ok" | "problem"
}`;

function extractJson(raw: string): Record<string, unknown> | null {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(raw.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function main() {
  const dirArg = process.argv.indexOf('--dir');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logDir = dirArg >= 0 ? process.argv[dirArg + 1] : join(repoRoot, 'logs/sessions');

  const files = readdirSync(logDir).filter((f) => f.endsWith('.txt'));
  const parsed = files
    .map((f) => parseLog(f, readFileSync(join(logDir, f), 'utf8')))
    // Only sessions with a real listener question (≥1 user QA turn).
    .filter((p) => p.qa.some((t) => t.role === 'user'));

  console.log(`Parsed ${files.length} logs; ${parsed.length} have a listener Q&A to grade.\n`);
  if (parsed.length === 0) {
    console.log('No Q&A sessions to grade. (Manual /tutor tests with an interrupt will land here.)');
    return;
  }

  const llm = createGeminiCompletion({
    apiKey: process.env.GOOGLE_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  });

  const graded: Array<Record<string, unknown>> = [];
  console.log('| session | verdict | issues |');
  console.log('|---|---|---|');
  for (const s of parsed) {
    let result: Record<string, unknown> | null = null;
    try {
      result = extractJson(await llm(JUDGE_PROMPT(s)));
    } catch (e) {
      result = { verdict: 'error', issues: [(e as Error).message] };
    }
    const verdict = (result?.verdict as string) ?? 'parse-error';
    const issues = Array.isArray(result?.issues) ? (result!.issues as string[]) : [];
    graded.push({ session: s.sessionId, file: s.file, ...result });
    console.log(`| ${s.sessionId.slice(-12)} | ${verdict === 'ok' ? '✅ ok' : '⚠️ ' + verdict} | ${issues.join('; ') || '—'} |`);
  }

  const outDir = join(repoRoot, 'docs/experiments/2026-05-30-session-eval/data');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'graded.json'), JSON.stringify(graded, null, 2));
  const problems = graded.filter((g) => g.verdict !== 'ok').length;
  console.log(`\n${problems}/${graded.length} sessions flagged. Raw → ${outDir}/graded.json`);
}

main().catch((e) => { console.error('grader fatal:', e); process.exit(1); });

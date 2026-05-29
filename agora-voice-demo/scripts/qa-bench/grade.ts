// QA bench grader.
//
// Reads a bench output file (produced by run.ts) + cases.json (rubrics) and
// scores every case PASS/FAIL against its rubric. Two layers:
//
//   1. DETERMINISTIC GATES (reproducible, no model) — the objective criteria.
//      These are the trustworthy core; they decide PASS/FAIL on their own and
//      can never be overridden by the judge:
//        - source !== 'fallback' (the planner must have actually run)
//        - forbidden_in_planner: none of the spoiler/forbidden substrings appear
//          in bridge_text, replacement_segments[].text, OR the qa_answer
//        - expected_strategy: if not 'any', plan.resume_strategy must match
//        - structural assertions parsed straight from the rubric text, e.g.
//          "resume_strategy == 'restart'" and "replacement_segments[0].id == 's2'"
//        - language guardrail: C1 (language-switch-to-chinese) requires the
//          planner text to be CJK-dominant; every other case requires it to
//          stay Latin-dominant (catches an unwanted language flip).
//
//   2. LLM JUDGE (Gemini) — the semantic rubric lines that can't be checked by
//      string ops ("agrees to switch", "preserves story canon", "reassuring
//      without lying"). One structured call per case. temperature 0.
//
//   A case PASSES iff every deterministic gate passes AND every judged hard
//   criterion returns PASS. qa_soft / planner_soft lines are scored advisory-
//   only and never gate.
//
// Judge bias note: only GOOGLE_API_KEY is configured, so the judge is the same
// model family as the generator. The deterministic gates cover the criteria
// most central to the language-switch bug (CJK detection, forbidden, source),
// so the C1 verdict in particular does NOT depend on the judge. Semantic-only
// verdicts carry MED confidence; this is surfaced in the report.
//
// Usage:
//   pnpm tsx scripts/qa-bench/grade.ts \
//     --in  docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression.json \
//     --out docs/experiments/2026-05-28-qa-resume-benchmark/outputs/regression-graded.json \
//     [--no-judge]   # deterministic gates only (offline, no API calls)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env';

// Dedicated judge client. Uses a CAPABLE model (default gemini-2.5-flash, a
// real step up from the flash-lite generation model) at temperature 0.
//
// CRITICAL: reasoning_effort:'minimal' is REQUIRED, not optional. The 2.x-flash
// models are thinking-capable; left to think freely they spend the whole token
// budget on reasoning and return a TRUNCATED (or empty) body, so the JSON array
// never closes and every criterion falls through to a spurious FAIL. The prod
// gemini-client documents this exact failure. We keep reasoning minimal and give
// a generous max_tokens so the verdict array always lands intact.
function createJudge(model: string): (prompt: string) => Promise<string> {
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  return async (prompt: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.geminiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 4096,
        reasoning_effort: 'minimal',
      }),
    });
    if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return j.choices?.[0]?.message?.content ?? '';
  };
}

interface Rubric {
  qa_hard?: string[];
  qa_soft?: string[];
  planner_hard?: string[];
  planner_soft?: string[];
  expected_strategy?: string;
  forbidden_in_planner?: string[];
  // Opt-in deterministic gates (added 2026-05-29 for C11-C15). When absent the
  // gate does not fire — keeps C1-C10 historical baselines bit-for-bit comparable.
  qa_max_sentences?: number;
  qa_no_meta_preface?: boolean;
}
interface CaseSpec {
  id: string;
  label: string;
  qa_question: string;
  rubric: Rubric;
}
interface ReplacementSeg { id: string; text: string }
interface Plan {
  bridge_text: string;
  resume_strategy: string;
  replacement_segments: ReplacementSeg[];
  active_scene_id: string;
}
interface CaseResult {
  case_id: string;
  label: string;
  qa_question: string;
  qa_answer: string;
  planner_plan: Plan;
  planner_source: string;
}

interface Check {
  kind: 'deterministic' | 'judge';
  criterion: string;
  pass: boolean;
  reason: string;
}
interface GradedCase {
  case_id: string;
  label: string;
  pass: boolean;
  checks: Check[];
  soft_notes: string[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const inPath = get('--in');
  const outPath = get('--out');
  const noJudge = args.includes('--no-judge');
  // Judge defaults to a CAPABLE model, deliberately stronger than the
  // flash-lite generation model so rubric evaluation is trustworthy, but not
  // the heavyweight reasoning pro tier (too slow for an interactive gate).
  const judgeModel = get('--judge-model') ?? 'gemini-3.5-flash';
  // --cases overrides the rubric source (default: the 16-case dev set).
  // --fixture overrides the story (default: fairy-tale fixture.json). The
  // grader reads fixture.canon_summary into the judge prompt; if you point at
  // a new domain (B9), drop a canon_summary field in that fixture.
  const casesPath = get('--cases');
  const fixturePath = get('--fixture');
  if (!inPath || !outPath) {
    throw new Error('usage: --in <outputs.json> --out <graded.json> [--no-judge] [--judge-model <id>] [--cases <path>] [--fixture <path>]');
  }
  return { inPath, outPath, noJudge, judgeModel, casesPath, fixturePath };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');
const expDir = join(repoRoot, 'docs/experiments/2026-05-28-qa-resume-benchmark');

// ── language detection ────────────────────────────────────────────────
function cjkRatio(text: string): number {
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const denom = cjk + latin;
  return denom === 0 ? 0 : cjk / denom;
}

function plannerText(plan: Plan): string {
  return [plan.bridge_text, ...plan.replacement_segments.map((s) => s.text)].join('\n');
}

// ── opt-in deterministic helpers (added 2026-05-29) ──────────────────
// Count terminators . ! ? 。 ！ ？ (ASCII and CJK). Treats ellipses (…, ...)
// as ONE terminator, and ignores a sole trailing terminator so "Hi there!"
// scores as 1 not 1+ε. Best-effort — tutor-style answers are 1-2 sentences
// short, so simple terminator counting is robust enough; no abbreviation
// heuristics needed at this length.
function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const normalised = trimmed.replace(/\.{2,}/g, '…');
  const matches = normalised.match(/[.!?。！？…]/g);
  return matches ? matches.length : 1;
}

// Detect a persona-violating meta-preface at the START of the qa_answer.
// Returns the offending token (lowercased), or null if the opening is clean.
// Looks at the first ~40 chars only so a legit mid-sentence "let's" doesn't fire.
const META_PREFACES = ['okay', 'sure', 'alright', 'let me', "let's", 'i will', "i'll", 'of course', 'i can'];
function detectMetaPreface(text: string): string | null {
  const head = text.trim().slice(0, 40).toLowerCase();
  for (const p of META_PREFACES) {
    if (head === p || head.startsWith(p + ' ') || head.startsWith(p + ',') || head.startsWith(p + '.') || head.startsWith(p + '!') || head.startsWith(p + '—')) {
      return p;
    }
  }
  return null;
}

// ── deterministic gates ───────────────────────────────────────────────
function deterministicChecks(c: CaseSpec, r: CaseResult): Check[] {
  const checks: Check[] = [];
  const pText = plannerText(r.planner_plan);
  const allText = `${r.qa_answer}\n${pText}`;

  // 1. planner must have actually run (not the templated fallback)
  checks.push({
    kind: 'deterministic',
    criterion: 'planner source is llm (not fallback)',
    pass: r.planner_source === 'llm',
    reason: `source=${r.planner_source}`,
  });

  // 2. forbidden substrings — applied to planner text AND qa answer
  const forbidden = c.rubric.forbidden_in_planner ?? [];
  for (const word of forbidden) {
    const hit = allText.toLowerCase().includes(word.toLowerCase());
    checks.push({
      kind: 'deterministic',
      criterion: `forbidden substring absent: "${word}"`,
      pass: !hit,
      reason: hit ? `LEAKED "${word}"` : 'absent',
    });
  }

  // 3. expected strategy (when pinned)
  const exp = c.rubric.expected_strategy;
  if (exp && exp !== 'any') {
    checks.push({
      kind: 'deterministic',
      criterion: `resume_strategy == '${exp}'`,
      pass: r.planner_plan.resume_strategy === exp,
      reason: `got '${r.planner_plan.resume_strategy}'`,
    });
  }

  // 4. structural assertions parsed straight out of planner_hard rubric text
  for (const line of c.rubric.planner_hard ?? []) {
    // resume_strategy == 'restart'
    const mStrat = line.match(/resume_strategy\s*==\s*'(\w+)'/);
    if (mStrat) {
      checks.push({
        kind: 'deterministic',
        criterion: `resume_strategy == '${mStrat[1]}' (from rubric)`,
        pass: r.planner_plan.resume_strategy === mStrat[1],
        reason: `got '${r.planner_plan.resume_strategy}'`,
      });
    }
    // replacement_segments[0].id == 's2'
    const mId = line.match(/replacement_segments\[0\]\.id\s*==\s*'(\w+)'/);
    if (mId) {
      const got = r.planner_plan.replacement_segments[0]?.id;
      checks.push({
        kind: 'deterministic',
        criterion: `replacement_segments[0].id == '${mId[1]}'`,
        pass: got === mId[1],
        reason: `got '${got}'`,
      });
    }
  }

  // 5. qa_max_sentences — opt-in deterministic cap on qa_answer length.
  //    Persona constraint "≤2 short sentences" is currently judged by the LLM;
  //    this gate makes it free + reproducible for cases that opt in. C1-C10
  //    leave the rubric field unset, so the gate is silent there.
  if (typeof c.rubric.qa_max_sentences === 'number') {
    const max = c.rubric.qa_max_sentences;
    const count = countSentences(r.qa_answer);
    checks.push({
      kind: 'deterministic',
      criterion: `qa_answer has at most ${max} sentence${max === 1 ? '' : 's'}`,
      pass: count <= max,
      reason: `got ${count}`,
    });
  }

  // 6. qa_no_meta_preface — opt-in deterministic check for the persona-violating
  //    openings (okay/sure/let me/I will/...) that the C1 judge-line describes.
  //    Detects them at the START of qa_answer (first ~40 chars), so a legit
  //    mid-sentence "okay" doesn't trip the gate.
  if (c.rubric.qa_no_meta_preface === true) {
    const found = detectMetaPreface(r.qa_answer);
    checks.push({
      kind: 'deterministic',
      criterion: 'qa_answer has no meta-preface (okay/sure/alright/let me/let\'s/i will/i\'ll/of course)',
      pass: found === null,
      reason: found === null ? 'clean opening' : `prefaced with "${found}"`,
    });
  }

  // 7. language guardrail — the objective heart of the language-switch test
  const ratio = cjkRatio(pText);
  if (c.label === 'language-switch-to-chinese') {
    checks.push({
      kind: 'deterministic',
      criterion: 'planner text is Chinese-dominant (CJK ratio > 0.5)',
      pass: ratio > 0.5,
      reason: `cjk_ratio=${ratio.toFixed(2)}`,
    });
  } else {
    checks.push({
      kind: 'deterministic',
      criterion: 'planner text stays English (no unwanted language flip, CJK ratio < 0.05)',
      pass: ratio < 0.05,
      reason: `cjk_ratio=${ratio.toFixed(2)}`,
    });
  }

  return checks;
}

// Criteria already covered by a deterministic gate → don't double-judge them.
function isCoveredDeterministically(line: string): boolean {
  return (
    /resume_strategy\s*==/.test(line) ||
    /replacement_segments\[0\]\.id\s*==/.test(line)
  );
}

// ── LLM judge ─────────────────────────────────────────────────────────
// Default canon — the fairy-tale dev set. Used when the fixture (or its
// `canon_summary` field) is not available. Cross-domain fixtures (B9) override
// this by setting `canon_summary` in the fixture JSON, which grade.ts reads
// from --fixture and threads through here.
const DEFAULT_CANON_SUMMARY = "The protagonist is Lina (莉娜), a curious girl in a red coat. Mosk (莫斯克) is a grumpy grey old fox in a green vest guarding a humming tree. Lina gives Mosk an apple. The tree hums because a firefly queen is inside; long ago Mosk failed to save a friend with medicine. These later reveals (firefly/queen/medicine) are SPOILERS for early scenes.";

function buildJudgePrompt(c: CaseSpec, r: CaseResult, criteria: string[], canonSummary: string): string {
  const plan = r.planner_plan;
  return `You are a strict evaluator for a tutor that reads a long-form session aloud. The listener interrupted with a question; below are the tutor's spoken answer and its plan for resuming the session. Judge whether each criterion is satisfied.

LISTENER QUESTION: "${c.qa_question}"

TUTOR'S SPOKEN ANSWER:
"""
${r.qa_answer}
"""

RESUME PLAN:
  resume_strategy: ${plan.resume_strategy}
  bridge_text: "${plan.bridge_text}"
  replacement_segments:
${plan.replacement_segments.map((s, i) => `    ${i + 1}. [${s.id}] "${s.text}"`).join('\n')}

Session canon (for reference): ${canonSummary}

Evaluate ONLY these criteria. For each, decide PASS (clearly satisfied) or FAIL (not satisfied or ambiguous). Be strict but fair.

CRITERIA:
${criteria.map((cr, i) => `  ${i + 1}. ${cr}`).join('\n')}

Output ONLY a JSON array, one object per criterion in order, no prose, no fences:
[{"criterion": "<echo the criterion>", "verdict": "PASS" | "FAIL", "reason": "<≤15 words>"}]`;
}

function parseJudgeJson(raw: string): Array<{ criterion: string; verdict: string; reason: string }> {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const first = cleaned.indexOf('[');
  const last = cleaned.lastIndexOf(']');
  if (first < 0 || last < first) throw new Error('no JSON array in judge output');
  return JSON.parse(cleaned.slice(first, last + 1));
}

// One judge call per case covering BOTH hard and soft criteria; the verdicts
// are partitioned afterwards (hard → gating checks, soft → advisory notes).
// Halves the call count vs grading hard/soft separately.
async function judgeCase(
  c: CaseSpec,
  r: CaseResult,
  judge: (p: string) => Promise<string>,
  canonSummary: string,
): Promise<{ hard: Check[]; soft: string[] }> {
  const hardLines = [
    ...(c.rubric.qa_hard ?? []),
    ...(c.rubric.planner_hard ?? []),
  ].filter((l) => !isCoveredDeterministically(l));
  const softLines = [...(c.rubric.qa_soft ?? []), ...(c.rubric.planner_soft ?? [])];
  const allLines = [...hardLines, ...softLines];
  if (allLines.length === 0) return { hard: [], soft: [] };

  let verdicts: Array<{ criterion: string; verdict: string; reason: string }>;
  try {
    verdicts = parseJudgeJson(await judge(buildJudgePrompt(c, r, allLines, canonSummary)));
  } catch (err) {
    // A judge failure must NOT silently pass — fail every hard line loudly.
    return {
      hard: hardLines.map((l) => ({
        kind: 'judge' as const,
        criterion: l,
        pass: false,
        reason: `judge error: ${(err as Error).message}`,
      })),
      soft: softLines.map((l) => `?: ${l} — (judge unavailable)`),
    };
  }
  const hard = hardLines.map((l, i) => {
    const v = verdicts[i];
    return {
      kind: 'judge' as const,
      criterion: l,
      pass: v?.verdict?.toUpperCase() === 'PASS',
      reason: v?.reason ?? 'no verdict returned',
    };
  });
  const soft = softLines.map((l, i) => {
    const v = verdicts[hardLines.length + i];
    return `${v?.verdict ?? '?'}: ${l} — ${v?.reason ?? ''}`;
  });
  return { hard, soft };
}

async function main() {
  const { inPath, outPath, noJudge, judgeModel, casesPath, fixturePath } = parseArgs();
  const cases = (JSON.parse(readFileSync(casesPath ?? join(expDir, 'cases.json'), 'utf8')).cases as CaseSpec[]);
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const inFile = JSON.parse(readFileSync(inPath, 'utf8')) as {
    meta?: { fixture_path?: string };
    results: CaseResult[];
  };

  // Resolve canon for the judge: explicit --fixture flag wins; else use the
  // fixture_path the runner recorded in meta (so a cross-domain run that
  // forgot to re-pass --fixture to grade.ts still works); else default canon.
  let canonSummary = DEFAULT_CANON_SUMMARY;
  const resolvedFixture = fixturePath ?? inFile.meta?.fixture_path;
  if (resolvedFixture) {
    try {
      const fixtureAbs = resolvedFixture.startsWith('/') ? resolvedFixture : join(repoRoot, resolvedFixture);
      const fx = JSON.parse(readFileSync(fixtureAbs, 'utf8')) as { canon_summary?: string };
      if (typeof fx.canon_summary === 'string' && fx.canon_summary.trim()) {
        canonSummary = fx.canon_summary;
      } else {
        console.warn(`[grade] WARN: fixture ${resolvedFixture} has no canon_summary — using default fairy-tale canon (judge may misread cross-domain runs)`);
      }
    } catch (err) {
      console.warn(`[grade] WARN: could not read fixture ${resolvedFixture} (${(err as Error).message}) — using default canon`);
    }
  }

  const judge = noJudge ? null : createJudge(judgeModel);
  if (judge) console.log(`[grade] judge_model=${judgeModel}`);

  // Grade every case concurrently — each case is one independent judge call.
  const graded: GradedCase[] = (
    await Promise.all(
      inFile.results.map(async (r): Promise<GradedCase | null> => {
        const baseId = r.case_id.replace(/_t\d+$/, ''); // strip trial suffix (C1_t2 → C1)
        const c = caseById.get(baseId);
        if (!c) {
          console.warn(`  ! no rubric for ${r.case_id}, skipping`);
          return null;
        }
        const det = deterministicChecks(c, r);
        const { hard, soft } = judge ? await judgeCase(c, r, judge, canonSummary) : { hard: [], soft: [] };
        const checks = [...det, ...hard];
        const pass = checks.every((x) => x.pass);
        console.log(
          `  ${r.case_id} (${c.label}): ${pass ? 'PASS' : `FAIL (${checks.filter((x) => !x.pass).map((x) => x.criterion).join('; ')})`}`,
        );
        return { case_id: r.case_id, label: c.label, pass, checks, soft_notes: soft };
      }),
    )
  ).filter((g): g is GradedCase => g !== null);

  const nPass = graded.filter((g) => g.pass).length;
  const summary = {
    graded_at: new Date().toISOString(),
    in_path: inPath.replace(repoRoot + '/', ''),
    judge_model: noJudge ? null : judgeModel,
    n_cases: graded.length,
    n_pass: nPass,
    n_fail: graded.length - nPass,
    cases: graded,
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  // ── markdown table to stdout ──
  console.log('\n| case | label | verdict | failed checks |');
  console.log('|---|---|---|---|');
  for (const g of graded) {
    const failed = g.checks.filter((x) => !x.pass).map((x) => x.criterion).join('; ') || '—';
    console.log(`| ${g.case_id} | ${g.label} | ${g.pass ? '✅ PASS' : '❌ FAIL'} | ${failed} |`);
  }
  console.log(`\n${nPass}/${graded.length} PASS — wrote ${outPath}`);
  if (nPass !== graded.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[grade] fatal:', err);
  process.exit(1);
});

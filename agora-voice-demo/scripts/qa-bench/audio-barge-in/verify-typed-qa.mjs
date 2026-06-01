// Verify the QA ANSWER path end-to-end WITHOUT voice/STT, against any URL.
//
// The user's "无视我的QA" was a VOICE barge-in, but synthetic mic audio gives
// 0% Deepgram STT so automation can't drive the voice path. The TYPED-question
// path exercises the same answer pipeline (branch-started → narrator pause →
// agent reply via sendText → IN-ANSWER render) with NO STT dependency. So this
// is the best automatable proxy for "does the agent actually answer + render it
// cleanly (not a narration-leak mislabel)".
//
//   BARGE_BASE_URL=https://talkalong-tutor.onrender.com node …/verify-typed-qa.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { deriveTypedQaVerdict } from './run-latency-lib.mjs';

const BASE = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const TOPIC = process.env.TOPIC || 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const QUESTION = process.env.QUESTION || 'What is the name of the cat?';
// Substring the answer MUST contain to count as "actually answered". Defaults to
// 'pemberley' for the cat-name question; override (or set to '' to skip) when the
// QUESTION isn't a naming one (e.g. a "why" question has no single required word).
const EXPECT = (process.env.EXPECT ?? 'pemberley').toLowerCase();
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS || 200000);
const OUT = '/tmp/spike-mic/typed-qa';

function parseSeam(line) {
  const m = line.match(/\[seam\]\s+(\d+)\s+(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { t: Number(m[1]), ev: m[2], detail: (m[3] ?? '').trim() };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const seams = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('console', (m) => {
      if (!m.text().includes('[seam]')) return;
      const raw = m.text().replace(/^.*\[seam\]/, '[seam]');
      const parsed = parseSeam(raw);
      seams.push(parsed ? { ...parsed, raw } : raw);
    });
    await page.goto(`${BASE}/tutor?voicelog=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('textarea, input[type="text"]').first().fill(TOPIC);
    await page.locator('button', { hasText: /begin/i }).first().click();
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
    console.log('story screen up; waiting for the SESSION to be live before typing…');
    // Gate typing on the session actually being live, NOT a fixed delay. Under a
    // slow cold-start compose the first narration segment can land ~25s after the
    // scene-dots appear; typing before sessionInfo is set makes onTextQuestion
    // no-op (`if (!sessionInfo) return`) → the question is silently dropped (no
    // branch, no answer). The first `segment` (or `state speaking`) seam proves
    // the orchestrator session started. (Harness flake fixed 2026-06-01.)
    const sessionLive = async () =>
      seams.some((s) => typeof s !== 'string' && (s.ev === 'segment' || (s.ev === 'state' && s.detail === 'speaking')));
    for (let i = 0; i < 60 && !(await sessionLive()); i++) await page.waitForTimeout(1000);
    if (!(await sessionLive())) throw new Error('session never went live (no segment/speaking seam) — compose stalled');
    // How long to let the narration run before barging in. Lower = earlier barge
    // (more narration still mid-flight); higher = the opening (incl. names) has
    // been spoken. Tunable so we can probe timing-dependent behavior.
    await page.waitForTimeout(Number(process.env.NARRATE_MS || 3000));

    // Switch to keyboard mode + type the question.
    const kb = page.getByTitle('Keyboard');
    await kb.waitFor({ state: 'visible', timeout: 10000 }).catch(async (err) => {
      await page.screenshot({ path: `${OUT}/typed-qa-no-keyboard.png` }).catch(() => {});
      throw new Error(`Keyboard toggle not found on StoryScreen; cannot drive typed QA: ${err.message}`);
    });
    await kb.click();
    const tb = page.locator('input[placeholder*="Type a question to interrupt"]');
    await tb.waitFor({ state: 'visible', timeout: 5000 });
    await tb.fill(QUESTION);
    await tb.press('Enter');
    // Confirm the submit actually registered (typed_txt seam). If the keypress
    // was eaten by a focus/StrictMode race, re-type once before giving up.
    const typed = async () => seams.some((s) => typeof s !== 'string' && s.ev === 'typed_txt');
    await page.waitForTimeout(800);
    if (!(await typed())) {
      console.log('no typed_txt seam yet — re-submitting once');
      await tb.fill(QUESTION);
      await tb.press('Enter');
    }
    console.log(`typed question: "${QUESTION}" — waiting for the answer…`);
    await page.waitForTimeout(500);
    const instantVerdict = deriveTypedQaVerdict(seams.filter((s) => typeof s !== 'string'));
    await page.waitForTimeout(16000);
    await page.screenshot({ path: `${OUT}/typed-qa.png` }).catch(() => {});
    const finalVerdict = deriveTypedQaVerdict(seams.filter((s) => typeof s !== 'string'));

    // Pull the answer text: the teacher bubble(s) flagged "IN ANSWER TO YOU".
    const answers = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('div')) {
        const t = el.innerText || '';
        if (/IN ANSWER TO YOU/i.test(t) && t.length < 600 && el.querySelectorAll('div').length < 4) {
          out.push(t.replace(/IN ANSWER TO YOU/i, '').trim());
        }
      }
      return [...new Set(out)].filter((text) => text.length > 0);
    });

    console.log('\n=== IN-ANSWER bubbles ===');
    answers.forEach((a, i) => console.log(`  [${i}] ${a.slice(0, 200)}`));
    console.log('\n=== seams (tail) ===');
    seams.slice(-12).forEach((s) => console.log('  ' + (typeof s === 'string' ? s : s.raw)));

    const named = !EXPECT || answers.some((a) => a.toLowerCase().includes(EXPECT));
    // The agent-error fallback ("…having trouble answering right now…") is NOT an
    // answer — if every bubble is the fallback, the agent didn't actually reply.
    const isFallback =
      answers.length > 0 && answers.every((a) => /trouble answering right now/i.test(a));
    // A real narration LEAK = the QA bubble shows story prose INSTEAD of an
    // answer (the C3 bug). Markers must be narration-ONLY: dropped "guardian of"
    // — that's the cat's ROLE ("the guardian of the library is called Pemberley")
    // and appears in a correct in-character answer, so it false-flagged a genuine
    // reply. And a bubble that correctly names the cat is BY DEFINITION an answer,
    // not narration-instead-of-answer, so naming overrides the heuristic.
    const NARRATION_ONLY = /padded softly|grassy hill/i;
    const leak = !named && answers.some((a) => NARRATION_ONLY.test(a));
    const agentErrors = seams
      .filter((s) => typeof s !== 'string' && s.ev === 'agent_error')
      .map((s) => s.detail);
    console.log('\n=== TYPED-QA VERDICT ===');
    console.log(`  instant hush: ${instantVerdict.hush_ok ? '✅' : '❌'} ${instantVerdict.hush_ms ?? '—'}ms`);
    console.log(`  instant typed branch: ${instantVerdict.branch_ok ? '✅' : '❌'} ${instantVerdict.branch_ms ?? '—'}ms`);
    if (agentErrors.length) console.log(`  agent errors: ${agentErrors.join(', ')}`);
    for (const f of instantVerdict.failures) console.log(`    - ${f}`);
    console.log(`  got an IN-ANSWER bubble: ${answers.length > 0 ? '✅' : '❌'}`);
    console.log(`  answer contains "${EXPECT || '(any)'}": ${named ? '✅' : '❓'}`);
    console.log(`  not the error-fallback: ${isFallback ? '❌ FALLBACK' : '✅'}`);
    console.log(`  answer is NOT a narration leak: ${leak ? '❌ LEAK' : '✅'}`);
    // Honest gate: the bubble must exist, NOT be the error-fallback (which masked
    // the llm:505 bug), contain the expected token if one is set, and not be a
    // narration leak.
    const pass =
      instantVerdict.ok && finalVerdict.ok && answers.length > 0 && named && !isFallback && !leak;
    console.log(`  ${pass ? '✅ PASS — agent answered, rendered as a clean QA answer' : '❌ FAIL — no clean answer'}`);
    console.log(`  screenshot: ${OUT}/typed-qa.png`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}
main();

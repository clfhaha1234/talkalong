// Same-session typed interrupt regression harness.
//
// The single-case matrix starts a fresh lesson per case, so it cannot catch a
// stale branch/SSE state that only appears after multiple Q&A cycles in one
// session. This script asks several questions in the SAME story. By default it
// uses the realistic rhythm "ask → answer → resume narration for at least one
// segment → ask again", and requires each question to open a fresh typed branch
// and receive a visible answer.
//
//   BARGE_BASE_URL=https://talkalong-tutor.onrender.com pnpm test:e2e:typed:sequential

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { deriveQaResumeVerdict, deriveTypedQaVerdict, evaluateQaAnswer } from './run-latency-lib.mjs';

const BASE = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const TOPIC =
  process.env.TOPIC || 'Tell a short 5-scene bedtime story about a library cat named Pemberley.';
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS || 200000);
const WAIT_FOR_NEXT_SEGMENT = process.env.WAIT_FOR_NEXT_SEGMENT !== '0';
const ROUND_TIMEOUT_MS = Number(process.env.ROUND_TIMEOUT_MS || 45000);
const OUT = '/tmp/spike-mic/typed-qa-sequential';

const CASES = [
  {
    id: 'opener',
    waitMs: 1000,
    question: 'Hello? Can you hear me?',
    expected: '',
    kind: 'opener',
    allowTease: false,
  },
  {
    id: 'early-fact',
    waitMs: 1500,
    question: 'What is the name of the cat?',
    expected: '',
    kind: 'any',
    allowTease: true,
  },
  {
    id: 'late-fact',
    waitMs: 5000,
    question: 'What is the name of the cat?',
    expected: 'pemberley',
    kind: 'factual',
    allowTease: false,
  },
];

function parseSeam(line) {
  const m = line.match(/\[seam\]\s+(\d+)\s+(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { t: Number(m[1]), ev: m[2], detail: (m[3] ?? '').trim(), raw: line };
}

async function answerBubbles(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('div')) {
      const t = el.innerText || '';
      if (/IN ANSWER TO YOU/i.test(t) && t.length < 600 && el.querySelectorAll('div').length < 4) {
        out.push(t.replace(/IN ANSWER TO YOU/i, '').trim());
      }
    }
    return [...new Set(out)].filter((text) => text.length > 0);
  });
}

async function waitForNewSegment(page, seams, fromIndex, label) {
  if (!WAIT_FOR_NEXT_SEGMENT) return true;
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (seams.slice(fromIndex).some((s) => typeof s !== 'string' && s.ev === 'segment')) {
      console.log(`round gap before ${label}: ✅ saw resumed narration segment`);
      return true;
    }
    await page.waitForTimeout(500);
  }
  console.log(`round gap before ${label}: ❌ no resumed narration segment within ${ROUND_TIMEOUT_MS}ms`);
  return false;
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
      seams.push(parsed ?? raw);
    });

    await page.goto(`${BASE}/tutor?voicelog=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('textarea, input[type="text"]').first().fill(TOPIC);
    await page.locator('button', { hasText: /begin/i }).first().click();
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });

    const sessionLive = () =>
      seams.some((s) => typeof s !== 'string' && (s.ev === 'segment' || (s.ev === 'state' && s.detail === 'speaking')));
    for (let i = 0; i < 70 && !sessionLive(); i += 1) await page.waitForTimeout(1000);
    if (!sessionLive()) throw new Error('session never went live');

    const kb = page.getByTitle('Keyboard');
    await kb.waitFor({ state: 'visible', timeout: 10000 });
    await kb.click();
    const tb = page.locator('input[placeholder*="Type a question to interrupt"]');
    await tb.waitFor({ state: 'visible', timeout: 5000 });

    const results = [];
    let resumeFromSeam = 0;
    for (let caseIndex = 0; caseIndex < CASES.length; caseIndex += 1) {
      const c = CASES[caseIndex];
      console.log(`\n========== sequential typed: ${c.id} ==========`);
      if (caseIndex > 0) {
        const sawRound = await waitForNewSegment(page, seams, resumeFromSeam, c.id);
        if (!sawRound) {
          results.push({ id: c.id, ok: false });
          continue;
        }
      }
      await page.waitForTimeout(c.waitMs);
      const beforeSeams = seams.length;
      const beforeAnswers = (await answerBubbles(page)).length;

      await tb.fill(c.question);
      await tb.press('Enter');
      await page.waitForTimeout(800);
      if (!seams.slice(beforeSeams).some((s) => typeof s !== 'string' && s.ev === 'typed_txt')) {
        console.log('no typed_txt seam yet — re-submitting once');
        await tb.fill(c.question);
        await tb.press('Enter');
      }

      await page.waitForTimeout(17000);
      const caseSeams = seams.slice(beforeSeams).filter((s) => typeof s !== 'string');
      const answers = (await answerBubbles(page)).slice(beforeAnswers);
      const renderedAnswerSlot = caseSeams.some(
        (s) => s.ev === 'qa_pairs' && /:a\b/.test(String(s.detail ?? '')),
      );
      const typedVerdict = deriveTypedQaVerdict(caseSeams);
      const resumeVerdict = deriveQaResumeVerdict(caseSeams);
      const answerText = answers.join(' ') || (renderedAnswerSlot ? (await answerBubbles(page)).at(-1) ?? '' : '');
      const answerVerdict = evaluateQaAnswer(answerText, {
        expected: c.expected,
        kind: c.kind,
        rejectTease: !c.allowTease,
      });
      const ok = typedVerdict.ok && resumeVerdict.ok && renderedAnswerSlot && answerVerdict.ok;

      console.log(`question: "${c.question}"`);
      console.log(`answers: ${answers.map((a) => `"${a.slice(0, 160)}"`).join(' | ') || (answerText ? `"${answerText.slice(0, 160)}"` : '(none)')}`);
      console.log(`branch: ${typedVerdict.branch_ok ? '✅' : '❌'} ${typedVerdict.branch_ms ?? '—'}ms`);
      console.log(`hush: ${typedVerdict.hush_ok ? '✅' : '❌'} ${typedVerdict.hush_ms ?? '—'}ms`);
      console.log(
        `resume: ${resumeVerdict.ok ? '✅' : '❌'} ${resumeVerdict.qa_post_after_reply_ms ?? '—'}ms after agent_reply`,
      );
      console.log(`rendered answer slot: ${renderedAnswerSlot ? '✅' : '❌'}`);
      console.log(`answer: ${answerVerdict.ok ? '✅' : '❌'}`);
      for (const f of [...typedVerdict.failures, ...resumeVerdict.failures, ...answerVerdict.failures]) {
        console.log(`  - ${f}`);
      }
      results.push({ id: c.id, ok });
      resumeFromSeam = seams.length;
    }

    await page.screenshot({ path: `${OUT}/typed-qa-sequential.png` }).catch(() => {});
    const failures = results.filter((r) => !r.ok);
    console.log('\n========== sequential typed verdict ==========');
    console.log(`cases=${results.length} failures=${failures.length}`);
    console.log(failures.length ? '❌ FAIL — same-session repeated interrupts regressed' : '✅ PASS — repeated interrupts clean');
    process.exit(failures.length ? 1 : 0);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('sequential typed fatal:', e);
  process.exit(1);
});

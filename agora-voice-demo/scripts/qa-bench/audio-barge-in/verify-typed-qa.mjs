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
    console.log('story screen up; letting narration start…');
    await page.waitForTimeout(8000);

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

    const named = answers.some((a) => /pemberley/i.test(a));
    const leak = answers.some((a) => /padded softly|grassy hill|guardian of/i.test(a)); // narration phrases
    const agentErrors = seams
      .filter((s) => typeof s !== 'string' && s.ev === 'agent_error')
      .map((s) => s.detail);
    console.log('\n=== TYPED-QA VERDICT ===');
    console.log(`  instant hush: ${instantVerdict.hush_ok ? '✅' : '❌'} ${instantVerdict.hush_ms ?? '—'}ms`);
    console.log(`  instant typed branch: ${instantVerdict.branch_ok ? '✅' : '❌'} ${instantVerdict.branch_ms ?? '—'}ms`);
    if (agentErrors.length) console.log(`  agent errors: ${agentErrors.join(', ')}`);
    for (const f of instantVerdict.failures) console.log(`    - ${f}`);
    console.log(`  got an IN-ANSWER bubble: ${answers.length > 0 ? '✅' : '❌'}`);
    console.log(`  answer names the cat (Pemberley): ${named ? '✅' : '❓'}`);
    console.log(`  answer is NOT a narration leak: ${leak ? '❌ LEAK' : '✅'}`);
    const pass = instantVerdict.ok && finalVerdict.ok && answers.length > 0 && !leak;
    console.log(`  ${pass ? '✅ PASS — agent answered, rendered as a clean QA answer' : '❌ FAIL — no clean answer'}`);
    console.log(`  screenshot: ${OUT}/typed-qa.png`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}
main();

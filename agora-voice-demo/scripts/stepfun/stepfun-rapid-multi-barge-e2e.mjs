// Rapid multi-turn fake-mic e2e for /stepfun.
//
// Same idea as stepfun-multi-barge-e2e, but the SECOND question lands while the
// first answer is still playing (or in its follow-up window) instead of after a
// long quiet gap. This exercises the duck-then-commit barge-in paths that the
// relaxed multi-barge test never reaches:
//   - barge-in during 'answering' (pause the answer, supersede it with a new turn)
//   - barge-in during 'thinking' (abort the in-flight QA turn)
//   - resume integrity after back-to-back interrupts (narration must come back)
//
// Usage:
//   STEPFUN_URL=http://localhost:3001/stepfun node scripts/stepfun/stepfun-rapid-multi-barge-e2e.mjs
//   GAP_SECONDS=5 STEPFUN_URL=https://talkalong-tutor.onrender.com/stepfun node scripts/stepfun/stepfun-rapid-multi-barge-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const RAW_BASE = process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001';
const URL = RAW_BASE.endsWith('/stepfun') ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/stepfun`;
const OUT = '/tmp/spike-mic/stepfun';
// With measured prod timings (thinking ~2s after Q1 ends, answer audio ~5s),
// a 5s gap drops Q2 squarely into the middle of answer #1.
const GAP_SECONDS = Number(process.env.GAP_SECONDS ?? 5);
const WAV = `${OUT}/rapid-multi-barge-gap${GAP_SECONDS}.wav`;
const TOPIC = process.env.TOPIC ?? 'Tell a short 3-scene bedtime story about a library cat named Pemberley in a small town library.';
const Q1 = process.env.Q1 ?? 'What is the name of the cat?';
const Q2 = process.env.Q2 ?? 'Where does Pemberley live?';
const EXPECT1 = (process.env.EXPECT1 ?? 'pemberley').toLowerCase();
const EXPECT2 = (process.env.EXPECT2 ?? 'library').toLowerCase();
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 180000);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 90000);
// After both answers, narration must come back within this long stop — a rapid
// second interrupt historically broke resume state on /tutor.
const RESUME_TIMEOUT_MS = Number(process.env.RESUME_TIMEOUT_MS ?? 30000);

function sh(cmd) {
  execSync(cmd, { stdio: 'pipe' });
}

function genQuestion(text, stem) {
  sh(`say -o "${stem}.aiff" -v Samantha --rate=150 "${text.replace(/"/g, '\\"')}"`);
  sh(`ffmpeg -y -i "${stem}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${stem}.wav" 2>/dev/null`);
}

function genSilence(path, seconds) {
  sh(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${seconds}" "${path}" 2>/dev/null`);
}

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync(OUT, { recursive: true });
  const s = `${OUT}/rapid`;
  genQuestion(Q1, `${s}-q1`);
  genQuestion(Q2, `${s}-q2`);
  genSilence(`${s}-lead.wav`, 6);
  genSilence(`${s}-gap.wav`, GAP_SECONDS);
  genSilence(`${s}-trail.wav`, 45);
  sh(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-q1.wav" -i "${s}-gap.wav" -i "${s}-q2.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
  );
  console.log(`generated ${WAV} (gap ${GAP_SECONDS}s)`);
}

function pageProbe() {
  const text = document.body.innerText || '';
  const answers = [];
  for (const label of document.querySelectorAll('div')) {
    if ((label.textContent || '').trim() !== 'IN ANSWER TO YOU') continue;
    const bubble = label.parentElement;
    const t = (bubble?.innerText || '').replace(/IN ANSWER TO YOU/i, '').trim();
    if (t) answers.push(t);
  }
  const topStatus = /\bNARRATING\b/.test(text)
    ? 'NARRATING'
    : /\bLISTENING\b/.test(text)
      ? 'LISTENING'
      : /\bANSWERING\b/.test(text)
        ? 'ANSWERING'
        : /\bTHINKING\b/.test(text)
          ? 'THINKING'
          : /\bPAUSED\b/.test(text)
            ? 'PAUSED'
            : 'UNKNOWN';
  return {
    topStatus,
    micBlocked: /Microphone blocked|Permission denied/i.test(text),
    answers: [...new Set(answers)],
    body: text.slice(0, 2000),
  };
}

async function main() {
  genWav();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const timeline = [];
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (/error|warn|Permission denied/i.test(t)) console.log(`   [console] ${t.slice(0, 220)}`);
    });

    console.log(`1. open ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('textarea').first().fill(TOPIC);
    await page.waitForTimeout(1200);
    const begin = page.locator('button', { hasText: /Begin/i }).first();
    await begin.click();
    await page.waitForTimeout(800);
    if (!/Preparing tonight|Drafting/i.test(await page.locator('body').innerText().catch(() => ''))) {
      await begin.click({ force: true });
      await page.waitForTimeout(800);
    }

    console.log('2. wait for story screen...');
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
    console.log(`   story screen reached; Q2 lands ~${GAP_SECONDS}s after Q1 (mid-answer).`);

    const start = Date.now();
    let bothAnswersAt = null;
    let resumedAt = null;
    let last = '';
    while (Date.now() - start < OBSERVE_MS) {
      const snap = await page.evaluate(pageProbe);
      const t = Date.now() - start;
      const label = `${snap.topStatus}/${snap.answers.length} answer(s)`;
      if (label !== last) {
        last = label;
        console.log(`   [state] ${label} @${t}ms`);
      }
      timeline.push({ t, ...snap });
      if (snap.answers.length >= 2 && bothAnswersAt === null) {
        bothAnswersAt = t;
        console.log(`   both answers present @${t}ms; waiting for narration to resume...`);
      }
      if (bothAnswersAt !== null && snap.topStatus === 'NARRATING') {
        resumedAt = t;
        console.log(`   narration resumed @${t}ms (${t - bothAnswersAt}ms after 2nd answer)`);
        break;
      }
      if (bothAnswersAt !== null && t - bothAnswersAt > RESUME_TIMEOUT_MS) break;
      await page.waitForTimeout(400);
    }

    await page.screenshot({ path: `${OUT}/stepfun-rapid-multi-barge.png`, fullPage: true }).catch(() => {});
    const final = timeline[timeline.length - 1] ?? await page.evaluate(pageProbe);
    const answerText = final.answers.join(' ');
    const noMicBlock = !timeline.some((x) => x.micBlocked);
    const aCount = final.answers.length;
    const hasFirst = answerText.toLowerCase().includes(EXPECT1);
    const hasSecond = answerText.toLowerCase().includes(EXPECT2);
    const resumed = resumedAt !== null;

    console.log('\n=== STEPFUN RAPID MULTI-BARGE VERDICT ===');
    console.log(`  url:              ${URL}`);
    console.log(`  gap:              ${GAP_SECONDS}s (Q2 lands mid-answer)`);
    console.log(`  mic accepted:     ${noMicBlock ? '✅' : '❌'}`);
    console.log(`  answer bubbles:   ${aCount}`);
    final.answers.forEach((a, i) => console.log(`    [${i}] ${a.slice(0, 180)}`));
    console.log(`  contains ${EXPECT1}: ${hasFirst ? '✅' : '❌'}`);
    console.log(`  contains ${EXPECT2}: ${hasSecond ? '✅' : '❌'}`);
    console.log(`  narration resumed: ${resumed ? `✅ @${resumedAt}ms` : '❌ (stuck after rapid interrupts)'}`);
    console.log(`  screenshot:       ${OUT}/stepfun-rapid-multi-barge.png`);

    const pass = noMicBlock && aCount >= 2 && hasFirst && hasSecond && resumed;
    console.log(`\n  ${pass ? '✅ PASS — rapid back-to-back voice barge-ins work' : '❌ FAIL — rapid multi-barge regression'}`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('stepfun rapid multi-barge e2e fatal:', e);
  process.exit(1);
});

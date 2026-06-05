// Fake-mic e2e for the StepFun after-answer follow-up window.
//
// The old /stepfun path resumed narration immediately when answer audio ended,
// so a mic-check answer ("I can hear you...") was followed by the main story
// almost at once. This test catches that exact race: after the answer appears,
// the page must stay out of NARRATING for a short guard window.
//
// Usage:
//   STEPFUN_URL=http://localhost:3001/stepfun node scripts/stepfun/stepfun-followup-window-e2e.mjs
//   STEPFUN_URL=https://talkalong-tutor.onrender.com/stepfun node scripts/stepfun/stepfun-followup-window-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const RAW_BASE = process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001';
const URL = RAW_BASE.endsWith('/stepfun') ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/stepfun`;
const OUT = '/tmp/spike-mic/stepfun';
const WAV = `${OUT}/followup-window-${Date.now()}.wav`;
const TOPIC = process.env.TOPIC ?? 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const QUESTION = process.env.QUESTION ?? 'Can you hear me?';
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 180000);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 65000);
const NO_RESUME_GUARD_MS = Number(process.env.N0_RESUME_GUARD_MS ?? process.env.NO_RESUME_GUARD_MS ?? 4500);

function sh(cmd) {
  execSync(cmd, { stdio: 'pipe' });
}

function genWav() {
  mkdirSync(OUT, { recursive: true });
  const s = `${OUT}/followup-window`;
  sh(`say -o "${s}.aiff" -v Samantha --rate=150 "${QUESTION.replace(/"/g, '\\"')}"`);
  sh(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-q.wav" 2>/dev/null`);
  sh(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=6" "${s}-lead.wav" 2>/dev/null`);
  sh(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=30" "${s}-trail.wav" 2>/dev/null`);
  sh(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-q.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2]concat=n=3:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
  );
  console.log(`generated ${WAV}`);
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
    body: text.slice(0, 2200),
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
    console.log(`   story screen reached; fake mic asks "${QUESTION}" after its lead silence.`);

    const start = Date.now();
    let answerAt = null;
    let narratingDuringGuardAt = null;
    let last = '';
    while (Date.now() - start < OBSERVE_MS) {
      const snap = await page.evaluate(pageProbe);
      const t = Date.now() - start;
      if (snap.answers.length && answerAt === null) {
        answerAt = t;
        console.log(`   answer appeared @${answerAt}ms`);
      }
      if (answerAt !== null && t - answerAt <= NO_RESUME_GUARD_MS && snap.topStatus === 'NARRATING') {
        narratingDuringGuardAt = t;
        break;
      }
      const label = `${snap.topStatus}/${snap.answers.length} answer(s)`;
      if (label !== last) {
        last = label;
        console.log(`   [state] ${label} @${t}ms`);
      }
      timeline.push({ t, ...snap });
      if (answerAt !== null && t - answerAt > NO_RESUME_GUARD_MS) break;
      await page.waitForTimeout(250);
    }

    await page.screenshot({ path: `${OUT}/stepfun-followup-window.png`, fullPage: true }).catch(() => {});
    const final = timeline[timeline.length - 1] ?? await page.evaluate(pageProbe);
    const answer = final.answers.join(' ');
    const noMicBlock = !timeline.some((x) => x.micBlocked);
    const gotAnswer = answer.length > 0;
    const heldWindow = gotAnswer && narratingDuringGuardAt === null;

    console.log('\n=== STEPFUN FOLLOW-UP WINDOW VERDICT ===');
    console.log(`  url:                 ${URL}`);
    console.log(`  mic accepted:        ${noMicBlock ? 'PASS' : 'FAIL'}`);
    console.log(`  answer bubble:       ${gotAnswer ? 'PASS' : 'FAIL'}`);
    console.log(`  no resume <${NO_RESUME_GUARD_MS}ms: ${heldWindow ? 'PASS' : `FAIL @${narratingDuringGuardAt}ms`}`);
    console.log(`  final status:        ${final.topStatus}`);
    console.log(`  answer:              "${answer.slice(0, 220) || '(none)'}"`);
    console.log(`  screenshot:          ${OUT}/stepfun-followup-window.png`);

    const pass = noMicBlock && gotAnswer && heldWindow;
    console.log(`\n  ${pass ? 'PASS — after-answer follow-up window is preserved' : 'FAIL — story resumed too quickly or QA failed'}`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('stepfun follow-up window e2e fatal:', e);
  process.exit(1);
});

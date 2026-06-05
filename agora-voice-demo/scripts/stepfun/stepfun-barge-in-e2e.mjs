// Full fake-mic e2e for /stepfun.
//
// Drives the tutor-style StepFun page in Chromium with a fake microphone:
//   StepFun lesson generation -> local VAD pauses narration -> StepFun ASR ->
//   Gemini-lite QA brain -> StepFun streaming TTS -> IN ANSWER TO YOU bubble.
//
// Usage:
//   STEPFUN_URL=http://localhost:3001/stepfun node scripts/stepfun/stepfun-barge-in-e2e.mjs
//   STEPFUN_URL=https://talkalong-tutor.onrender.com/stepfun node scripts/stepfun/stepfun-barge-in-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const RAW_BASE = process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001';
const URL = RAW_BASE.endsWith('/stepfun') ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/stepfun`;
const OUT = '/tmp/spike-mic/stepfun';
const WAV = `${OUT}/cat-name-barge-in.wav`;
const TOPIC = process.env.TOPIC ?? 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const QUESTION = process.env.QUESTION ?? 'What is the name of the cat?';
const EXPECT = (process.env.EXPECT ?? 'pemberley').toLowerCase();
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 180000);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 55000);

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync(OUT, { recursive: true });
  const s = `${OUT}/cat-name`;
  execSync(`say -o "${s}.aiff" -v Samantha --rate=150 "${QUESTION.replace(/"/g, '\\"')}"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-q.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=6" "${s}-lead.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=30" "${s}-trail.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-q.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2]concat=n=3:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
    { stdio: 'pipe' },
  );
  console.log(`generated ${WAV}`);
}

function pageProbe() {
  const text = document.body.innerText || '';
  const answers = [];
  for (const el of document.querySelectorAll('div')) {
    const t = el.innerText || '';
    if (/IN ANSWER TO YOU/i.test(t) && t.length < 700 && el.querySelectorAll('div').length < 5) {
      answers.push(t.replace(/IN ANSWER TO YOU/i, '').trim());
    }
  }
  return {
    hasStory: !!document.querySelector('[data-testid="scene-dots"]'),
    micBlocked: /Microphone blocked|Permission denied/i.test(text),
    listening: /Listening|listening/i.test(text),
    thinking: /thinking|answering/i.test(text),
    answerText: [...new Set(answers)].join(' '),
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
    // Give React hydration a moment. Clicking the SSR button too early is a
    // silent no-op in headless Chromium, leaving the page on the input screen.
    await page.waitForTimeout(1200);
    const begin = page.locator('button', { hasText: /Begin/i }).first();
    await begin.click();
    await page.waitForTimeout(800);
    if (!/Preparing tonight|Drafting/i.test(await page.locator('body').innerText().catch(() => ''))) {
      await begin.click({ force: true });
      await page.waitForTimeout(800);
    }

    console.log('2. wait for tutor-style story screen...');
    try {
      await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
    } catch (e) {
      await page.screenshot({ path: `${OUT}/stepfun-compose-timeout.png`, fullPage: true }).catch(() => {});
      const body = await page.locator('body').innerText().catch(() => '');
      console.log(`   compose timeout body="${body.slice(0, 1000).replace(/\s+/g, ' ')}"`);
      console.log(`   screenshot: ${OUT}/stepfun-compose-timeout.png`);
      throw e;
    }
    console.log('   story screen reached; fake mic should play after its 6s lead silence.');

    const start = Date.now();
    let last = '';
    while (Date.now() - start < OBSERVE_MS) {
      const snap = await page.evaluate(pageProbe);
      const label = snap.answerText
        ? 'answer'
        : snap.micBlocked
          ? 'mic-blocked'
          : snap.thinking
            ? 'thinking'
            : snap.listening
              ? 'listening'
              : 'story';
      if (label !== last) {
        last = label;
        console.log(`   [phase] ${label} @${Date.now() - start}ms`);
      }
      timeline.push({ t: Date.now() - start, ...snap });
      if (snap.answerText) break;
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: `${OUT}/stepfun-barge-in.png`, fullPage: true }).catch(() => {});
    const final = timeline[timeline.length - 1] ?? await page.evaluate(pageProbe);
    const answer = final.answerText ?? '';
    const sawMic = timeline.some((x) => x.listening || x.thinking || x.answerText);
    const noMicBlock = !timeline.some((x) => x.micBlocked);
    const gotAnswer = answer.length > 0;
    const containsExpected = !EXPECT || answer.toLowerCase().includes(EXPECT);

    console.log('\n=== STEPFUN FAKE-MIC VERDICT ===');
    console.log(`  url:             ${URL}`);
    console.log(`  mic accepted:    ${noMicBlock ? '✅' : '❌'}`);
    console.log(`  barge-in seen:   ${sawMic ? '✅' : '❌'}`);
    console.log(`  answer bubble:   ${gotAnswer ? '✅' : '❌'}`);
    console.log(`  contains ${EXPECT}: ${containsExpected ? '✅' : '❌'}`);
    console.log(`  answer:          "${answer.slice(0, 220) || '(none)'}"`);
    console.log(`  screenshot:      ${OUT}/stepfun-barge-in.png`);

    const pass = noMicBlock && sawMic && gotAnswer && containsExpected;
    console.log(`\n  ${pass ? '✅ PASS — /stepfun voice barge-in works end to end' : '❌ FAIL — see above'}`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('stepfun fake-mic e2e fatal:', e);
  process.exit(1);
});

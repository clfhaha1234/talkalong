// Multi-turn fake-mic e2e for /stepfun.
//
// Same as stepfun-barge-in-e2e, but feeds two spoken questions in one fake mic
// WAV. This catches the failure class that hurt /tutor most often: the first
// interrupt works, but resume/re-listen state is broken for later interrupts.

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const RAW_BASE = process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001';
const URL = RAW_BASE.endsWith('/stepfun') ? RAW_BASE : `${RAW_BASE.replace(/\/$/, '')}/stepfun`;
const OUT = '/tmp/spike-mic/stepfun';
const WAV = `${OUT}/multi-barge-v2.wav`;
const TOPIC = process.env.TOPIC ?? 'Tell a short 3-scene bedtime story about a library cat named Pemberley in a small town library.';
const Q1 = process.env.Q1 ?? 'What is the name of the cat?';
const Q2 = process.env.Q2 ?? 'Where does Pemberley live?';
const EXPECT1 = (process.env.EXPECT1 ?? 'pemberley').toLowerCase();
const EXPECT2 = (process.env.EXPECT2 ?? 'library').toLowerCase();
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 180000);
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 80000);

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
  const s = `${OUT}/multi`;
  genQuestion(Q1, `${s}-q1`);
  genQuestion(Q2, `${s}-q2`);
  genSilence(`${s}-lead.wav`, 6);
  genSilence(`${s}-gap.wav`, 18);
  genSilence(`${s}-trail.wav`, 30);
  sh(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-q1.wav" -i "${s}-gap.wav" -i "${s}-q2.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2][3][4]concat=n=5:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
  );
  console.log(`generated ${WAV}`);
}

function pageProbe(args) {
  const { q1, q2 } = args;
  const text = document.body.innerText || '';
  const answers = [];
  for (const label of document.querySelectorAll('div')) {
    if ((label.textContent || '').trim() !== 'IN ANSWER TO YOU') continue;
    const bubble = label.parentElement;
    const t = (bubble?.innerText || '').replace(/IN ANSWER TO YOU/i, '').trim();
    if (t) answers.push(t);
  }
  return {
    micBlocked: /Microphone blocked|Permission denied/i.test(text),
    listening: /Listening|listening/i.test(text),
    thinking: /thinking|answering/i.test(text),
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
    console.log('   story screen reached; fake mic will ask two questions.');

    const start = Date.now();
    let last = '';
    while (Date.now() - start < OBSERVE_MS) {
      const snap = await page.evaluate(pageProbe, { q1: Q1, q2: Q2 });
      const label = `${snap.answers.length} answer bubble(s)`;
      if (label !== last) {
        last = label;
        console.log(`   [qa] ${label} @${Date.now() - start}ms`);
      }
      timeline.push({ t: Date.now() - start, ...snap });
      if (snap.answers.length >= 2) {
        await page.waitForTimeout(4000);
        timeline.push({ t: Date.now() - start, ...(await page.evaluate(pageProbe, { q1: Q1, q2: Q2 })) });
        break;
      }
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: `${OUT}/stepfun-multi-barge.png`, fullPage: true }).catch(() => {});
    const final = timeline[timeline.length - 1] ?? await page.evaluate(pageProbe, { q1: Q1, q2: Q2 });
    const answerText = final.answers.join(' ');
    const noMicBlock = !timeline.some((x) => x.micBlocked);
    const sawBarge = timeline.some((x) => x.listening || x.thinking || x.answers.length > 0);
    const aCount = final.answers.length;
    const hasFirst = answerText.toLowerCase().includes(EXPECT1);
    const hasSecond = answerText.toLowerCase().includes(EXPECT2);

    console.log('\n=== STEPFUN MULTI-BARGE VERDICT ===');
    console.log(`  url:              ${URL}`);
    console.log(`  mic accepted:     ${noMicBlock ? '✅' : '❌'}`);
    console.log(`  barge-in seen:    ${sawBarge ? '✅' : '❌'}`);
    console.log(`  answer bubbles:   ${aCount}`);
    final.answers.forEach((a, i) => console.log(`    [${i}] ${a.slice(0, 180)}`));
    console.log(`  contains ${EXPECT1}: ${hasFirst ? '✅' : '❌'}`);
    console.log(`  contains ${EXPECT2}: ${hasSecond ? '✅' : '❌'}`);
    console.log(`  screenshot:       ${OUT}/stepfun-multi-barge.png`);

    const pass = noMicBlock && sawBarge && aCount >= 2 && hasFirst && hasSecond;
    console.log(`\n  ${pass ? '✅ PASS — multiple voice barge-ins work' : '❌ FAIL — multi-barge regression'}`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error('stepfun multi-barge e2e fatal:', e);
  process.exit(1);
});

// TIER 3 — language-switch subtitle/audio alignment (regression for the
// 2026-05-31 "voice switched to Chinese but subtitle stayed English" bug).
//
// Drives /tutor live: an ENGLISH story, then a fake-mic barge-in asking to
// continue in Chinese. The resume-planner rewrites the upcoming segments to
// Chinese and the agent SPEAKS Chinese; segment_started now carries that text
// and TutorPage syncs it into the displayed scene (scene-sync.ts). So the test
// is: after the switch, does a DISPLAYED narration bubble actually contain
// Chinese characters? (Before the fix it stayed English — audio≠subtitle.)
//
// OPT-IN, COSTS CREDITS, not in CI. Run against a live dev server:
//   node scripts/qa-bench/audio-barge-in/tutor-lang-switch-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const BASE_URL = process.env.TUTOR_URL ?? 'http://localhost:3000/tutor';
const WAV = '/tmp/spike-mic/lang-switch-q.wav';
const TOPIC = 'Tell a short 3-scene bedtime story about Albert and a train, in English.';
const QUESTION = 'Can you tell the rest of the story in Chinese please?';
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 95000);
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 160000);
const CJK = /[一-鿿]/;

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync('/tmp/spike-mic', { recursive: true });
  const s = '/tmp/spike-mic/lang-q';
  execSync(`say -o "${s}.aiff" -v Samantha --rate=150 "${QUESTION}"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-c.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=4" "${s}-gap.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=8" "${s}-lead.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=20" "${s}-trail.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2][3][4][5][6]concat=n=7:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
    { stdio: 'pipe' },
  );
  console.log(`generated ${WAV}`);
}

// Read all teacher NARRATION bubbles (skip the "IN ANSWER TO YOU" answer
// bubbles), via the avatar "T" glyph, filtering CSS leak.
async function readNarrationBubbles(page) {
  return page.evaluate(() => {
    const avatars = Array.from(document.querySelectorAll('div')).filter(
      (d) => d.textContent?.trim() === 'T' && d.children.length === 0,
    );
    const out = [];
    for (const a of avatars) {
      const row = a.parentElement;
      if (!row) continue;
      const full = (row.textContent ?? '').trim();
      if (/IN ANSWER TO YOU/.test(full)) continue;
      if (/[{}]|@keyframes|transform:/.test(full)) continue;
      const body = full.replace(/^T/, '').trim();
      if (body.length > 6) out.push(body);
    }
    return out;
  });
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
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  console.log('1. navigating + entering English topic…');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('textarea').first().fill(TOPIC);
  await page.locator('button:has-text("Begin")').first().click({ timeout: 8000 });

  console.log('2. waiting for story screen (scene-dots)…');
  await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
  console.log('   ✅ story screen; mic always-on → the "switch to Chinese" question is feeding.');

  console.log(`3. observing ${Math.round(OBSERVE_MS / 1000)}s for the switch; sampling displayed narration…`);
  let sawChineseSubtitle = false;
  let firstChinese = '';
  const pollEnd = Date.now() + OBSERVE_MS;
  while (Date.now() < pollEnd) {
    const bubbles = await readNarrationBubbles(page).catch(() => []);
    const zh = bubbles.find((b) => CJK.test(b));
    if (zh) {
      sawChineseSubtitle = true;
      firstChinese = zh;
      break;
    }
    await page.waitForTimeout(2000);
  }
  await browser.close();

  console.log(`\n=== LANG-SWITCH SUBTITLE VERDICT ===`);
  console.log(`  displayed a Chinese narration subtitle after the switch: ${sawChineseSubtitle ? '✅' : '❌'}`);
  if (sawChineseSubtitle) console.log(`  e.g.: "${firstChinese.slice(0, 80)}"`);
  console.log(`\n  ${sawChineseSubtitle ? '✅ PASS — subtitle followed the spoken language (audio==subtitle)' : '❌ FAIL — subtitle stayed non-Chinese; the rewrite did not reach the UI'}`);
  process.exit(sawChineseSubtitle ? 0 : 1);
}

main().catch((e) => {
  console.error('lang-switch e2e fatal:', e);
  process.exit(1);
});

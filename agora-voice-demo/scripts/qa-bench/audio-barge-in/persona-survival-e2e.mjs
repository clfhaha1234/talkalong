// PERSONA-SURVIVAL E2E — faithful gpt-4o-mini confirmation of the merged
// system-message fix.
//
// The comprehensive bench (gemini proxy) proved that sending persona +
// story-context as TWO system_messages drops the persona, and merging them into
// ONE fixes off-topic/meta/answer-then-stop (70%->100%). That fix shipped to
// prod (lib/orchestrator/index.ts syncContext). But the bench is a proxy — this
// confirms the SAME behavior on the REAL gpt-4o-mini via Agora:
//   - META  : "Are you a robot?" → must NOT admit being an AI/computer/program.
//   - OFFTOPIC: "What is thirteen times six?" → must NOT compute (no "78").
// Both are the persona's rules; if the merge fix works, gpt-4o-mini honors them.
//
// Drives the real /tutor flow, fake-mics both questions (repeated, so a rep
// lands during narration), reads the agent's real answers from the session log.
//
// Run: node scripts/qa-bench/audio-barge-in/persona-survival-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.TUTOR_URL ?? 'http://localhost:3000/tutor';
const WAV = '/tmp/spike-mic/persona-survival-q.wav';
const LOG_DIR = join(process.cwd(), 'logs/sessions');
const TOPIC = 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';

// QUESTION configurable: 'meta' (are you a robot) or 'math' (off-topic).
const MODE = process.argv.includes('--math') ? 'math' : 'meta';
const QUESTION = MODE === 'math' ? 'What is thirteen times six?' : 'Are you a robot or a real person?';

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync('/tmp/spike-mic', { recursive: true });
  const s = '/tmp/spike-mic/ps';
  // PROVEN structure (matches cat-name-e2e which fires reliably): 6s lead so the
  // mic publish is fully established, then the SAME question 4× with 4s gaps.
  execSync(`say -o "${s}-q.aiff" -v Samantha --rate=150 "${QUESTION}"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}-q.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-q.wav" 2>/dev/null`, { stdio: 'pipe' });
  const sil = (d, n) => execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${d}" "${s}-${n}.wav" 2>/dev/null`, { stdio: 'pipe' });
  sil(6, 'lead'); sil(4, 'gap'); sil(20, 'trail');
  const parts = [`${s}-lead.wav`, `${s}-q.wav`, `${s}-gap.wav`, `${s}-q.wav`, `${s}-gap.wav`, `${s}-q.wav`, `${s}-gap.wav`, `${s}-q.wav`, `${s}-trail.wav`];
  const inputs = parts.map((p) => `-i "${p}"`).join(' ');
  const concat = parts.map((_, i) => `[${i}]`).join('');
  execSync(`ffmpeg -y ${inputs} -filter_complex "${concat}concat=n=${parts.length}:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`, { stdio: 'pipe' });
  console.log(`generated ${WAV} (mode=${MODE}, question="${QUESTION}")`);
}

function newestLogAfter(tsMs) {
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs })).filter((x) => x.m >= tsMs)
    .sort((a, b) => b.m - a.m);
  return files[0] ? join(LOG_DIR, files[0].f) : null;
}

function parseQa(path) {
  const qa = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const q = line.match(/QA (user|agent): "(.*)"$/);
    if (q) qa.push({ role: q[1], text: q[2] });
  }
  return qa;
}

const AI_ADMIT = /\b(i am|i'?m) (an? )?(ai|a\.i\.|language model|computer|computer program|robot|chatbot|virtual assistant|artificial|program|machine|bot|assistant)|as an ai|large language model|i('?m| am) not (a )?(real|human|person)/i;
const MATH = /\b(78|seventy[- ]?eight)\b/i;

async function main() {
  genWav();
  const t0 = Date.now();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  console.log('1. topic + Begin…');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('textarea').first().fill(TOPIC);
  await page.locator('button:has-text("Begin")').first().click({ timeout: 8000 });
  console.log('2. waiting for narration…');
  await page.locator('button[aria-label="turn on microphone"]').waitFor({ state: 'visible', timeout: 150000 });
  await page.waitForTimeout(1500);
  console.log('3. tapping mic → dense alternating meta/math stream begins…');
  await page.locator('button[aria-label="turn on microphone"]').click();
  console.log('4. observing 90s (dense question stream across the whole narration)…');
  await page.waitForTimeout(90000);
  await browser.close();

  const logPath = newestLogAfter(t0);
  if (!logPath) { console.log('❌ no session log'); process.exitCode = 1; return; }
  const qa = parseQa(logPath);
  const agentText = qa.filter((t) => t.role === 'agent').map((t) => t.text).join(' ');
  const userQs = qa.filter((t) => t.role === 'user').map((t) => t.text);

  console.log(`\n=== PERSONA-SURVIVAL E2E VERDICT ===`);
  console.log(`  log: ${logPath.split('/').pop()}`);
  console.log(`  user questions heard: ${userQs.map((q) => `"${q}"`).join(' | ') || '(none)'}`);
  console.log(`  agent answers: "${agentText.slice(0, 240)}"`);
  const heard = userQs.length > 0;
  const brokeCharacter = AI_ADMIT.test(agentText);
  const computed = MATH.test(agentText);
  console.log(`\n  heard questions:        ${heard ? '✅' : '❌'}`);
  console.log(`  stayed in character:    ${!brokeCharacter ? '✅' : '❌ (admitted being an AI/robot)'}`);
  console.log(`  did NOT compute math:   ${!computed ? '✅' : '❌ (said 78)'}`);
  const pass = heard && !brokeCharacter && !computed;
  console.log(`\n  ${pass ? '✅ PASS — persona survived the merge on real gpt-4o-mini' : '❌ FAIL'}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => { console.error('e2e fatal:', e); process.exit(1); });

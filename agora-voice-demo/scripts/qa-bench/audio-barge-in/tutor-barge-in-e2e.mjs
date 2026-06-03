// TIER 3 — full-session fake-mic barge-in e2e for the CURRENT /tutor flow.
//
// This is the only layer that exercises the real round trip end to end: it
// drives /tutor in a real Chromium with a fake microphone, lets the REAL agent
// (Agora ConvoAI: Deepgram STT → gpt-4o-mini → MiniMax TTS) narrate a cat
// story, fake-mics the spoken question "What is the name of the cat?" DURING
// narration, and reads the agent's REAL spoken answer back from the server-side
// session log. It asserts the agent NAMES the cat (a name that appears in the
// narration) instead of teasing — which proves barge-in fired from real audio,
// the branch paused narration, and the say()-injected context reached the LLM.
//
// OPT-IN + COSTS CREDITS. NOT in `pnpm eval` / CI. Needs a dev server with live
// Agora credentials, plus macOS `say` + ffmpeg for the WAV. Run:
//   node scripts/qa-bench/audio-barge-in/tutor-barge-in-e2e.mjs
//
// vs the older cat-name-e2e.mjs: that one waited for a `turn on microphone`
// button + tapped it. The current StoryScreen has NO such button — the mic is
// ALWAYS-ON (TutorPage auto-sets micRequested once joined), so getUserMedia
// fires at session join and the fake WAV plays on its own. We key off the
// `scene-dots` testid to know the story screen is up, then just observe.

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateQaAnswer } from './run-latency-lib.mjs';

function tutorUrl() {
  const raw = process.env.TUTOR_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3000';
  return raw.endsWith('/tutor') ? raw : `${raw.replace(/\/$/, '')}/tutor`;
}

const BASE_URL = tutorUrl();
const WAV = '/tmp/spike-mic/tutor-barge-q.wav';
const LOG_DIR = join(process.cwd(), 'logs/sessions');
const TOPIC = 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 80000);
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 160000);

const STOP = new Set([
  'The', 'A', 'An', 'One', 'He', 'She', 'It', 'They', 'When', 'Then', 'But', 'And', 'As', 'In',
  'On', 'At', 'With', 'His', 'Her', 'Its', 'Their', 'That', 'This', 'There', 'Scene', 'Chapter',
  'While', 'For', 'So', 'Now', 'Once', 'Soon', 'Later', 'Library', 'Night', 'Day', 'Book', 'Books',
]);

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync('/tmp/spike-mic', { recursive: true });
  const s = '/tmp/spike-mic/tutor-q';
  // The question, volume-boosted, repeated 4× with 4s gaps after a 6s lead and
  // a 20s trail — robust to narration timing (one rep lands while the agent's
  // VAD is sampling). Discrete utterances, not a looped continuous phrase
  // (which the README warns confuses the LLM).
  execSync(`say -o "${s}.aiff" -v Samantha --rate=150 "What is the name of the cat?"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-c.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=4" "${s}-gap.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=6" "${s}-lead.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=20" "${s}-trail.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2][3][4][5][6][7][8]concat=n=9:v=0:a=1[a]" -map "[a]" "${WAV}" 2>/dev/null`,
    { stdio: 'pipe' },
  );
  console.log(`generated ${WAV}`);
}

function newestLogAfter(tsMs) {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
    .filter((x) => x.m >= tsMs)
    .sort((a, b) => b.m - a.m);
  return files[0] ? join(LOG_DIR, files[0].f) : null;
}

function parseSessionLog(path) {
  const raw = readFileSync(path, 'utf8');
  const segments = [];
  const qa = [];
  for (const line of raw.split(/\r?\n/)) {
    const seg = line.match(/segment_started \S+ "(.*)"$/);
    if (seg) segments.push(seg[1]);
    const q = line.match(/QA (user|agent): "(.*)"$/);
    if (q) qa.push({ role: q[1], text: q[2] });
  }
  return { segments, qa, raw };
}

function guessCatName(segments) {
  const counts = new Map();
  for (const seg of segments) {
    for (const tok of seg.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
      if (STOP.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

const TEASE = /haven'?t (learned|met|been told)|not learned|secret the story|keep listening|hasn'?t been (revealed|told)|just yet|find out/i;

async function main() {
  genWav();
  const t0 = Date.now();
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
  const transcripts = { user: 0, assistant: 0, states: [], userText: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('"object":"user.transcription"')) {
      transcripts.user++;
      const txt = (t.match(/"text":"([^"]*)"/) || [])[1];
      if (txt) transcripts.userText.push(txt);
      console.log(`   [STT user #${transcripts.user}] ${txt ?? '(heard speech)'}`);
    }
    if (t.includes('"object":"assistant.transcription"')) transcripts.assistant++;
    const st = t.match(/agent-state[^a-z]*([a-z]+)/i) || t.match(/AgentState[^a-z]*([a-z]+)/i);
    if (st) transcripts.states.push(st[1]);
  });

  console.log('1. navigating + entering topic…');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('textarea').first().fill(TOPIC);
  await page.locator('button:has-text("Begin")').first().click({ timeout: 8000 });

  console.log(`2. waiting for the story screen (scene-dots) — lesson compose can take ~2min…`);
  await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
  console.log('   ✅ story screen reached. mic is always-on → fake WAV is already feeding.');

  console.log(`3. observing ${Math.round(OBSERVE_MS / 1000)}s for barge-in → answer → qa-ended…`);
  // Poll the DOM composer hint to log the live phase transitions (reading →
  // listening → thinking) as a secondary barge-in signal.
  const seenPhases = new Set();
  let domAnswers = [];
  const pollEnd = Date.now() + OBSERVE_MS;
  while (Date.now() < pollEnd) {
    const hint = await page.locator('body').innerText().catch(() => '');
    for (const [re, label] of [
      [/just speak to interrupt/i, 'reading'],
      [/i’ll answer when you pause|listening/i, 'listening'],
      [/teacher is thinking/i, 'thinking'],
    ]) {
      if (re.test(hint) && !seenPhases.has(label)) {
        seenPhases.add(label);
        console.log(`   [phase] ${label}`);
      }
    }
    await page.waitForTimeout(1500);
  }
  domAnswers = await page
    .evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('div')) {
        const t = el.innerText || '';
        if (/IN ANSWER TO YOU/i.test(t) && t.length < 600 && el.querySelectorAll('div').length < 4) {
          out.push(t.replace(/IN ANSWER TO YOU/i, '').trim());
        }
      }
      return [...new Set(out)].filter((text) => text.length > 0);
    })
    .catch(() => []);
  await browser.close();
  console.log(`   STT: user.transcription=${transcripts.user}, assistant.transcription=${transcripts.assistant}, states=[${[...new Set(transcripts.states)].join(',')}], phases=[${[...seenPhases].join(',')}]`);
  if (domAnswers.length) {
    console.log(`   DOM answer bubbles: ${domAnswers.map((a) => `"${a.slice(0, 120)}"`).join(' | ')}`);
  }

  console.log('4. reading the server-side session log…');
  const logPath = newestLogAfter(t0);
  if (!logPath) {
    const answerVerdict = evaluateQaAnswer(domAnswers.join(' '), {
      expected: 'pemberley',
      kind: 'factual',
    });
    const bargeInFired = seenPhases.has('listening') || seenPhases.has('thinking');
    const pass = bargeInFired && answerVerdict.ok;
    console.log(
      '   no local session log found; using DOM answer fallback (expected for remote Render runs).',
    );
    console.log(`\n=== TIER-3 TUTOR BARGE-IN VERDICT ===`);
    console.log(`  log:                 (none local)`);
    console.log(`  phases:              [${[...seenPhases].join(',')}]`);
    console.log(`  agent answer:        "${domAnswers.join(' ').slice(0, 220) || '(none)'}"`);
    console.log(`\n  barge-in phase seen: ${bargeInFired ? '✅' : '❌'}`);
    console.log(`  answer bubble ok:    ${answerVerdict.ok ? '✅' : '❌'}`);
    for (const f of answerVerdict.failures) console.log(`    - ${f}`);
    console.log(`\n  ${pass ? '✅ PASS — remote barge-in answered from narrated context' : '❌ FAIL — see above'}`);
    process.exit(pass ? 0 : 1);
  }
  const { segments, qa } = parseSessionLog(logPath);
  const catName = guessCatName(segments);
  const userTurns = qa.filter((t) => t.role === 'user');
  const firstUserIdx = qa.findIndex((t) => t.role === 'user');
  const agentAfter = firstUserIdx >= 0 ? qa.slice(firstUserIdx).filter((t) => t.role === 'agent') : [];
  const answer = agentAfter.map((t) => t.text).join(' ');

  const heardQuestion = userTurns.length > 0 || transcripts.user > 0;
  const answered = answer.length > 0;
  const namesIt = catName ? new RegExp(`\\b${catName}\\b`, 'i').test(answer) : false;
  const teased = TEASE.test(answer);
  const pass = heardQuestion && answered && namesIt && !teased;

  console.log(`\n=== TIER-3 TUTOR BARGE-IN VERDICT ===`);
  console.log(`  log:                 ${logPath.split('/').pop()}`);
  console.log(`  narration scenes:    ${segments.length}`);
  console.log(`  guessed cat name:    ${catName ?? '(none)'}`);
  console.log(`  user Qs heard:       ${userTurns.map((t) => `"${t.text}"`).join(' | ') || '(none in log)'}`);
  console.log(`  agent answer:        "${answer.slice(0, 220) || '(none)'}"`);
  console.log(`\n  heard a question:    ${heardQuestion ? '✅' : '❌'}`);
  console.log(`  agent answered:      ${answered ? '✅' : '❌'}`);
  console.log(`  named the cat (${catName}): ${namesIt ? '✅' : '❌'}`);
  console.log(`  did NOT tease:       ${!teased ? '✅' : '❌ (teased)'}`);
  console.log(`\n  ${pass ? '✅ PASS — real barge-in answered from narrated context' : '❌ FAIL — see above'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('tier-3 e2e fatal:', e);
  process.exit(1);
});

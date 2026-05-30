// CAT-NAME E2E — the model-faithful test of the "what's the cat's name?" bug.
//
// This is the gold-standard layer the unit tests + Gemini bench could only
// approximate: it drives the REAL /tutor flow, lets the REAL gpt-4o-mini (via
// Agora) narrate a cat story, fake-mics the spoken question "What is the name
// of the cat?" during narration, and reads the agent's REAL spoken answer back
// from the server-side session log. It asserts the agent NAMES the cat (uses a
// name that actually appears in the narration) rather than teasing
// ("we haven't learned that yet"). It also implicitly validates:
//   - barge-in fires from real audio (not a synthetic event)
//   - B1: the qa_history in the session log is the real Q&A, not narration
//   - the context-sync fix: the agent has the narrated cat name in context
//
// Timing is controllable because /tutor only calls getUserMedia on the first
// mic tap (micRequested gates useLocalMicrophoneTrack) — so the fake-mic WAV
// starts playing the moment we click "turn on microphone", which we do AFTER
// narration has begun.
//
// Pre-flight: dev server running on :3000; macOS `say` + ffmpeg for the WAV.
// Run: node scripts/qa-bench/audio-barge-in/cat-name-e2e.mjs

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.TUTOR_URL ?? 'http://localhost:3000/tutor';
const WAV = '/tmp/spike-mic/cat-name-q.wav';
const LOG_DIR = join(process.cwd(), 'logs/sessions');
const TOPIC = 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
// Common sentence-starter / non-name capitalized words to ignore when guessing
// the cat's name from the narration.
const STOP = new Set(['The', 'A', 'An', 'One', 'He', 'She', 'It', 'They', 'When', 'Then', 'But', 'And', 'As', 'In', 'On', 'At', 'With', 'His', 'Her', 'Its', 'Their', 'That', 'This', 'There', 'Scene', 'Chapter', 'While', 'For', 'So', 'Now', 'Once', 'Soon', 'Later', 'Pemberley'.length ? 'Library' : '']);

function genWav() {
  if (existsSync(WAV)) return;
  mkdirSync('/tmp/spike-mic', { recursive: true });
  const s = '/tmp/spike-mic/cat-q';
  // Question, volume-boosted (fake-mic + ANS can attenuate). Then a track that
  // REPEATS the question 4× with 4s gaps after a 6s lead — robust to narration
  // timing (the agent is speaking; we need a rep to land when its VAD samples
  // the user). Spaced discrete utterances (not a looped continuous phrase, which
  // the README warns confuses the LLM).
  execSync(`say -o "${s}.aiff" -v Samantha --rate=150 "What is the name of the cat?"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-c.wav" 2>/dev/null`, { stdio: 'pipe' });
  // gap (4s) + question, repeated; preceded by 6s lead.
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
  // Most frequent capitalized non-stopword token across narration = the
  // recurring protagonist's name.
  const counts = new Map();
  for (const s of segments) {
    for (const tok of s.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
      if (STOP.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

const TEASE = /haven'?t (learned|met|been told)|not learned|secret the story|keep listening|hasn'?t been (revealed|told)|just yet/i;

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
  const console_lines = [];
  const transcripts = { user: 0, assistant: 0, states: [] };
  page.on('console', (m) => {
    const t = m.text();
    console_lines.push(t);
    if (t.includes('"object":"user.transcription"')) { transcripts.user++; console.log(`   [STT user] heard speech (#${transcripts.user})`); }
    if (t.includes('"object":"assistant.transcription"')) transcripts.assistant++;
    const st = t.match(/agent-state[^a-z]*([a-z]+)/i) || t.match(/AgentState[^a-z]*([a-z]+)/i);
    if (st) transcripts.states.push(st[1]);
  });

  console.log('1. navigating + entering topic…');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('textarea').first().fill(TOPIC);
  await page.locator('button:has-text("Begin")').first().click({ timeout: 8000 });

  console.log('2. waiting for narration to start (mic button appears on story screen)…');
  // Lesson compose + image gen can take up to ~120s.
  await page.locator('button[aria-label="turn on microphone"]').waitFor({ state: 'visible', timeout: 150000 });
  console.log('   story screen reached. letting scene 1 get going (~4s)…');
  await page.waitForTimeout(4000);

  console.log('3. tapping mic → fake-mic question plays ~6s later, during narration…');
  await page.locator('button[aria-label="turn on microphone"]').click();
  await page.waitForTimeout(800);
  // Confirm the tap registered (button should now read "mute microphone").
  const muteBtn = await page.locator('button[aria-label="mute microphone"]').count();
  console.log(`   mic now live (mute button present): ${muteBtn > 0 ? 'yes ✅' : 'NO ❌ — tap may not have unmuted'}`);
  // Observe: barge-in → agent answers → silence → qa-ended writes the log.
  console.log('4. observing 45s (4 question reps) for the agent answer + qa-ended…');
  await page.waitForTimeout(45000);
  await browser.close();
  console.log(`   STT diagnostics: user.transcription=${transcripts.user}, assistant.transcription=${transcripts.assistant}, states=[${[...new Set(transcripts.states)].join(',')}]`);

  console.log('5. reading the server-side session log…');
  const logPath = newestLogAfter(t0);
  if (!logPath) {
    console.log('❌ no session log written after run start — narration may not have begun.');
    process.exitCode = 1;
    return;
  }
  const { segments, qa } = parseSessionLog(logPath);
  const catName = guessCatName(segments);
  const userTurns = qa.filter((t) => t.role === 'user');
  // The agent's ANSWER = agent turns that come AFTER the first user question
  // (earlier agent lines may be narration echoes in pre-B1 logs).
  const firstUserIdx = qa.findIndex((t) => t.role === 'user');
  const agentAfter = firstUserIdx >= 0 ? qa.slice(firstUserIdx).filter((t) => t.role === 'agent') : [];
  const answer = agentAfter.map((t) => t.text).join(' ');

  console.log(`\n=== CAT-NAME E2E VERDICT ===`);
  console.log(`  log: ${logPath.split('/').pop()}`);
  console.log(`  narration scenes captured: ${segments.length}`);
  console.log(`  guessed cat name from narration: ${catName ?? '(none)'}`);
  console.log(`  user question heard by STT: ${userTurns.map((t) => `"${t.text}"`).join(' | ') || '(none — barge-in/STT failed)'}`);
  console.log(`  agent answer: "${answer.slice(0, 200) || '(none)'}"`);

  const namesIt = catName ? new RegExp(`\\b${catName}\\b`, 'i').test(answer) : false;
  const teased = TEASE.test(answer);
  const heardQuestion = userTurns.length > 0;

  let pass = heardQuestion && answer.length > 0 && namesIt && !teased;
  console.log(`\n  heard a question:   ${heardQuestion ? '✅' : '❌'}`);
  console.log(`  agent answered:     ${answer.length > 0 ? '✅' : '❌'}`);
  console.log(`  named the cat (${catName}): ${namesIt ? '✅' : '❌'}`);
  console.log(`  did NOT tease:      ${!teased ? '✅' : '❌ (teased instead of answering)'}`);
  console.log(`\n  ${pass ? '✅ PASS — gpt-4o-mini named the cat from narrated context' : '❌ FAIL — see above'}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => { console.error('e2e fatal:', e); process.exit(1); });

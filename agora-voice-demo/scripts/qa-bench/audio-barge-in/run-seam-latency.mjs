// Audio barge-in SEAM-based latency + quality harness (2026-06-01 rebuild).
//
// WHY THIS REPLACES THE DOM-POLLING run-latency.mjs:
//   - The old harness scraped DOM copy ("THE TEACHER", "· now reading ·") that
//     has since drifted (StoryScreen now renders "IN ANSWER TO YOU", chip
//     "narrating") → it silently reported all-null.
//   - Per memory `barge-in-latency-harness`: narration say() does NOT drive the
//     agent state to `speaking` (it stays silent/idle), so DOM `inBranch`
//     (keyed on speaking→listening) never flips for a narration barge-in.
//   So we time GROUND-TRUTH VOICE EVENTS, surfaced by TutorPage's gated seam
//   logger (`/tutor?voicelog=1` → console "[seam] <perf_ms> <event> [detail]").
//
// Seam vocabulary (emitted by components/TutorPage.tsx):
//   mic_live            getUserMedia fired = fake-mic WAV playhead t0
//   state <s>           agent-state-changed: listening|thinking|speaking|silent|idle
//   hush <0|100>        client muted/unmuted the agent's remote audio
//   user_txt <text>     a user STT transcription update (partial/final)
//   branch_post         client POSTed /api/tutor/branch-started
//   qa_post             client POSTed /api/tutor/qa-ended (silence-confirm fired)
//   segment <id>        a narration segment (re)started
//
// The three latencies a listener feels:
//   T1 interrupt→pause   question audible → agent registers speech (first
//                        `state listening` after onset). onset = mic_live +
//                        WAV lead silence.
//   T2 pause→reply       `state listening` → `state speaking` (the QA answer;
//                        narration never goes `speaking`, so this is the answer).
//   T3 reply→resume      answer ends (`state` leaves speaking) → narration
//                        `segment` (re)starts.
// Plus quality guards: false-barge-in rate (listening with no user_txt) and
// STT-completeness (did the question transcribe at all?).
//
// COSTS CREDITS + needs a live dev server (Agora+LLM) + macOS `say` + ffmpeg +
// playwright chromium. Usage:
//   node scripts/qa-bench/audio-barge-in/run-seam-latency.mjs --trials 3
//   BARGE_BASE_URL=http://localhost:3000 ... --question "How fast does light travel?"

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANDS, KNOWN_FIXED, band, deriveSeamLatencies, pct, resumeBudget } from './run-latency-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const OUT_DIR = '/tmp/spike-mic/seam';
const MIC_DIR = '/tmp/spike-mic/seam-wavs';
const OBSERVE_MS = Number(process.env.BARGE_OBSERVE_MS || 75000);
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS || 90000);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TRIALS = Number(opt('--trials', '1'));
const TOPIC = opt('--topic', 'Tell a short 3-scene bedtime story about a library cat named Pemberley.');
const QUESTION = opt('--question', 'What is the name of the cat?');
// Lead silence before the (single) spoken question. Long enough that narration
// is mid-scene when the question lands, short enough to fit the observe window.
const LEAD_MS = Number(opt('--lead', '11000'));

// ── Generate ONE clean spoken question WAV (no clipping). The old harness used
// `-af volume=3.0` which pushed max_volume to 0.0dB (hard clip) → distorted
// audio Deepgram couldn't transcribe (STT=0). We normalise to a safe peak.
function genWav() {
  mkdirSync(MIC_DIR, { recursive: true });
  const slug = QUESTION.replace(/[^a-z0-9]+/gi, '-').slice(0, 32).toLowerCase();
  const wav = join(MIC_DIR, `${slug}-lead${LEAD_MS}.wav`);
  if (existsSync(wav)) return wav;
  const s = join(MIC_DIR, '_tmp');
  const leadSec = (LEAD_MS / 1000).toFixed(2);
  execSync(`say -o "${s}.aiff" -v Samantha --rate=160 "${QUESTION}"`, { stdio: 'pipe' });
  // 16kHz mono, peak-normalise to -3dB (loud + clean, NOT clipped), then pad
  // with lead + trail silence so the question lands mid-narration.
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "loudnorm=I=-16:TP=-3:LRA=11" "${s}-c.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${leadSec}" "${s}-lead.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=25" "${s}-trail.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-c.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2]concat=n=3:v=0:a=1[a]" -map "[a]" "${wav}" 2>/dev/null`,
    { stdio: 'pipe' },
  );
  return wav;
}

// Parse "[seam] 12345 state listening" → {t:12345, ev:'state', detail:'listening'}
function parseSeam(line) {
  const m = line.match(/\[seam\]\s+(\d+)\s+(\w+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { t: Number(m[1]), ev: m[2], detail: (m[3] ?? '').trim() };
}

async function runTrial(wav, idx) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const seams = [];
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('[seam]')) { const p = parseSeam(txt); if (p) seams.push(p); }
    });
    await page.goto(`${BASE_URL}/tutor?voicelog=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Enter topic + Begin.
    const ta = page.locator('textarea, input[type="text"]').first();
    await ta.fill(TOPIC);
    await page.locator('button', { hasText: /begin/i }).first().click();

    // Wait for the story screen (compose can take a while; cached ~10s).
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });

    // Mic is always-on (TutorPage auto-requests once joined) → the fake WAV is
    // already feeding. Just observe the seam stream.
    await page.waitForTimeout(OBSERVE_MS);
    await ctx.close();
    return { trial: idx, seams, derived: deriveSeamLatencies(seams, LEAD_MS) };
  } finally {
    await browser.close();
  }
}

async function main() {
  const wav = genWav();
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`▶ seam-latency: ${TRIALS} trial(s) · Q="${QUESTION}" · lead=${LEAD_MS}ms\n  wav=${wav}\n  url=${BASE_URL}/tutor?voicelog=1\n`);

  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    console.log(`— trial ${i} —`);
    let r;
    try { r = await runTrial(wav, i); }
    catch (e) { console.log(`  ERROR ${String(e.message || e).slice(0, 160)}`); continue; }
    const d = r.derived;
    if (d.error) { console.log(`  ${d.error}; seams=${r.seams.length}`); }
    else {
      console.log(`  T1=${d.t1_pause_ms ?? '—'}ms T2=${d.t2_reply_ms ?? '—'}ms T3=${d.t3_resume_ms ?? '—'}ms | branch=${d.branch_posted ? 'yes' : 'NO'} STT="${d.stt_text ?? ''}" listens=${d.listen_count} false=${d.false_barge_count}`);
    }
    trials.push(r);
  }

  // Aggregate p50/p95 across trials.
  const ds = trials.map((t) => t.derived).filter((d) => d && !d.error);
  const agg = {
    n: ds.length,
    t1_p50: pct(ds.map((d) => d.t1_pause_ms), 50), t1_p95: pct(ds.map((d) => d.t1_pause_ms), 95),
    t2_p50: pct(ds.map((d) => d.t2_reply_ms), 50), t2_p95: pct(ds.map((d) => d.t2_reply_ms), 95),
    t3_p50: pct(ds.map((d) => d.t3_resume_ms), 50), t3_p95: pct(ds.map((d) => d.t3_resume_ms), 95),
    stt_ok_rate: ds.length ? ds.filter((d) => d.stt_ok).length / ds.length : null,
    branch_post_rate: ds.length ? ds.filter((d) => d.branch_posted).length / ds.length : null,
    false_barge_total: ds.reduce((a, d) => a + (d.false_barge_count || 0), 0),
  };

  writeFileSync(join(OUT_DIR, 'seam-latency.json'),
    JSON.stringify({ question: QUESTION, lead_ms: LEAD_MS, known_fixed: KNOWN_FIXED, bands: BANDS, trials, agg }, null, 2));

  console.log('\n# Barge-in seam latency (p50/p95, ms) — 🟢good 🟡ok 🔴sluggish');
  const cell = (p50, p95, b) => (p50 == null ? '—' : `${band(p50, b)} ${p50}/${p95}`);
  console.log('| n | ①stop-talk T1 | branch-post | ②answer T2 | ③resume T3 | STT-ok | false-barge |');
  console.log('|---|---|---|---|---|---|---|');
  console.log(`| ${agg.n} | ${cell(agg.t1_p50, agg.t1_p95, BANDS.t1_pause)} | ${agg.branch_post_rate == null ? '—' : Math.round(agg.branch_post_rate * 100) + '%'} | ${cell(agg.t2_p50, agg.t2_p95, BANDS.t2_reply)} | ${cell(agg.t3_p50, agg.t3_p95, BANDS.t3_resume)} | ${agg.stt_ok_rate == null ? '—' : Math.round(agg.stt_ok_rate * 100) + '%'} | ${agg.false_barge_total} |`);

  if (agg.branch_post_rate !== null && agg.branch_post_rate < 1) {
    console.log('\nFAIL: at least one listening/STT barge-in did not POST /api/tutor/branch-started.');
    console.log('      The UI may show a QA turn while the server narrator remains in MAIN.');
    process.exitCode = 1;
  }

  if (agg.stt_ok_rate === 0) {
    console.log('\n⚠️  STT-ok 0% — the synthetic `say` question never transcribed through');
    console.log('   Agora→Deepgram, so T2/T3 (answer+resume) are unmeasurable this run.');
    console.log('   T1 + false-barge ARE valid (VAD-only). For T2/T3 use a REAL human');
    console.log('   voice WAV (see README / P3-14): `--question`-matched recording in', MIC_DIR);
  }
  if (agg.t3_p50 != null) {
    const rb = resumeBudget(agg.t3_p50, KNOWN_FIXED.silence_confirm_ms);
    console.log(`\nresume T3 p50 = ${agg.t3_p50}ms = fixed silence-confirm ${rb.fixed_ms}ms + live ${rb.live_ms}ms`);
  }

  // Dump the first trial's seam timeline for eyeball debugging of seams.
  const first = trials.find((t) => t.seams?.length);
  if (first) {
    console.log('\n## seam timeline (trial 0, ms from page load)');
    for (const s of first.seams) console.log(`  ${String(s.t).padStart(6)}  ${s.ev}${s.detail ? ' · ' + s.detail.slice(0, 50) : ''}`);
  }
  console.log(`\nwrote ${join(OUT_DIR, 'seam-latency.json')}`);
}

main();

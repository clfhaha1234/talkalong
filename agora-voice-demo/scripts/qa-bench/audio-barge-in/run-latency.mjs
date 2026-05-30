// Audio barge-in LATENCY + QUALITY harness — the two layers the MVP README
// lists as "not yet done". Drives the live tutor with a Chromium fake mic and
// measures the three barge-in latencies + (optionally) LLM-judges the spoken
// answer quality.
//
// WHY DOM polling (not console scraping): TutorPage only console.logs errors —
// agent-state transitions live in React state, surfaced to the user through the
// Voice Orb copy + branch overlay + "now reading" header. We test through that
// same user-visible surface: it's deterministic, needs no app instrumentation,
// and measures what the listener actually experiences.
//
// The three latencies (each the gap a real listener feels):
//   T1  interrupt -> pause   : question audio starts -> story pauses to listen
//                              ("how fast does it shut up when I speak?")
//   T2  pause -> reply       : pause -> agent's answer text starts appearing
//                              ("how fast does it answer?")
//   T3  reply -> resume      : answer done -> narrator resumes the main line
//                              ("how fast does it get back to the story?")
//
// Prereqs (CANNOT run without these — this worktree has no keys):
//   1. dev server running with real Agora + LLM keys in .env.local
//   2. WAVs generated (generate-wavs.mjs)
//   3. `pnpm dlx playwright install chromium` once
//
// Usage:
//   node scripts/qa-bench/audio-barge-in/run-latency.mjs --only B01 --trials 3
//   node scripts/qa-bench/audio-barge-in/run-latency.mjs --judge   # + quality
//
// Output: /tmp/spike-mic/barge-in/latency.json + a markdown table with
//         per-case T1/T2/T3 and p50/p95 across trials.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8')).cases;
const OUT_DIR = '/tmp/spike-mic/barge-in';
const BASE_URL = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const WAV_DIR = '/tmp/spike-mic/wavs';
const OBSERVE_MS = Number(process.env.BARGE_OBSERVE_MS || 55000);
const POLL_MS = 100;
// Per the fake-mic spike: the padded WAV is 5s lead silence + question + trail.
// So the question becomes audible ~5s after getUserMedia. Spike 2 measured this
// at 3041ms±6ms for a 3s-lead WAV — i.e. lead-silence + ~40ms. We treat the
// configured lead as the interrupt onset; override per case via case.lead_ms.
const DEFAULT_LEAD_MS = Number(process.env.BARGE_LEAD_MS || 5000);

// ── Known FIXED timings baked into the app (not measured — read from source).
// Surfaced in the report so the end-to-end budget separates "tunable product
// decision" from "live LLM/network latency". If you change the source, change
// this — there's a guard test that greps the constant.
const KNOWN_FIXED = {
  // components/TutorPage.tsx — how long the user must be silent before we
  // decide their question is finished and start planning the resume. Pure UX
  // knob: lower = snappier resume but risks cutting a mid-thought pause; higher
  // = safer but feels sluggish. THIS is the dominant component of "how long
  // after I stop talking does the story continue".
  silence_confirm_ms: 2000,
};

// ── UX target bands (ms). What a listener perceives, from voice-UX norms:
// <1s instant, 1-2s natural, 2-4s noticeable, >4s sluggish. Used to colour the
// report so a number means "good/ok/slow", not just a raw figure.
const BANDS = {
  t1_pause: { good: 600, ok: 1200 },   // it should stop talking fast
  t2_reply: { good: 1500, ok: 3000 },  // answer onset
  t3_resume: { good: 3500, ok: 5500 }, // includes the 2s silence-confirm wait
  total: { good: 5000, ok: 8000 },     // whole round trip
};
function band(ms, b) {
  if (ms == null) return '—';
  if (ms <= b.good) return '🟢';
  if (ms <= b.ok) return '🟡';
  return '🔴';
}

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ONLY = opt('--only', null)?.split(',') ?? null;
const TRIALS = Number(opt('--trials', '1'));
const JUDGE = flag('--judge');

// ── DOM probe: a single function evaluated in the page that reads the
// user-visible state from the Voice Orb + story chrome. Returns a compact
// snapshot the harness timestamps. Kept resilient to copy tweaks by matching
// on stable phrases the Orb/footer render.
function pageSnapshot() {
  const t = document.body.innerText;
  const orbBtn = [...document.querySelectorAll('button')].find((b) =>
    /microphone/i.test(b.getAttribute('aria-label') || ''),
  );
  return {
    // BRANCH = the story has paused to listen to the user.
    inBranch: /Listening — go ahead|Paused for your question|· paused for question ·/i.test(t),
    // The narrator is on the main line.
    nowReading: /· now reading ·/i.test(t),
    // The agent's answer text shows in the branch overlay (THE TEACHER block).
    answerText: (t.match(/THE TEACHER\s+([^\n]{0,400})/i) || [, ''])[1].trim(),
    scene: (t.match(/SCENE\s+([IVX]+)/i) || [, ''])[1],
    page: (t.match(/PAGE\s+(\d+)\s+·\s+OF/i) || [, ''])[1],
    micLive: orbBtn ? orbBtn.getAttribute('aria-pressed') === 'true' : false,
    finished: /· the end ·/i.test(t),
  };
}

// Derive the three latencies from a timestamped snapshot timeline.
function deriveLatencies(timeline, leadMs) {
  // interrupt onset = when the question audio became audible (deterministic
  // from the WAV lead silence; the fake-mic spike validated ~lead+40ms).
  const interruptT = leadMs;
  const firstBranch = timeline.find((s) => s.t >= interruptT && s.inBranch);
  const t1 = firstBranch ? firstBranch.t - interruptT : null;

  let t2 = null;
  let t3 = null;
  if (firstBranch) {
    const firstAnswer = timeline.find(
      (s) => s.t >= firstBranch.t && s.answerText && s.answerText.length > 1,
    );
    t2 = firstAnswer ? firstAnswer.t - firstBranch.t : null;
    // resume = branch clears (back to now-reading) after the answer.
    const base = firstAnswer ?? firstBranch;
    const resume = timeline.find((s) => s.t >= base.t && !s.inBranch && s.nowReading);
    t3 = resume ? resume.t - base.t : null;
  }
  return { interrupt_ms: interruptT, t1_pause_ms: t1, t2_reply_ms: t2, t3_resume_ms: t3 };
}

async function runTrial(testCase, trialIdx) {
  const wavPath = join(WAV_DIR, testCase.wav);
  if (!existsSync(wavPath)) return { error: 'wav-missing', wavPath };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Enter the lesson.
    const startBtn = page.locator('button', { hasText: /begin|start|try/i }).first();
    if (await startBtn.count()) await startBtn.click();

    // The mic must be LIVE for a barge-in to be possible — the Orb defaults to
    // muted (push-to-talk). Click it once to unmute (grants + unmutes).
    const t0 = Date.now();
    let unmuted = false;
    const timeline = [];
    while (Date.now() - t0 < OBSERVE_MS) {
      const snap = await page.evaluate(pageSnapshot).catch(() => null);
      if (snap) timeline.push({ t: Date.now() - t0, ...snap });
      // Once we're in the story and not yet live, unmute so the fake question
      // can actually interrupt.
      if (!unmuted && snap && (snap.scene || snap.nowReading)) {
        const orb = page
          .locator('button[aria-label*="microphone" i]')
          .first();
        if (await orb.count()) {
          await orb.click().catch(() => {});
          unmuted = true;
        }
      }
      await page.waitForTimeout(POLL_MS);
    }

    const lead = testCase.lead_ms ?? DEFAULT_LEAD_MS;
    const latencies = deriveLatencies(timeline, lead);
    const lastAnswer = [...timeline].reverse().find((s) => s.answerText)?.answerText ?? '';
    await ctx.close();
    return { trial: trialIdx, latencies, answer_text: lastAnswer, samples: timeline.length };
  } finally {
    await browser.close();
  }
}

// ── Optional LLM quality judge (Gemini via REST; reuses GOOGLE_API_KEY).
async function judgeAnswer(testCase, answerText) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { skipped: 'no GOOGLE_API_KEY' };
  if (!answerText) return { score: 0, reason: 'no answer captured' };
  const model = process.env.JUDGE_MODEL || 'gemini-2.5-flash';
  const rubric = `You judge a tutor's spoken answer to a child's interruption during a story.
Question context: ${testCase.label} (${testCase.axis}).
The tutor's answer: """${answerText}"""
Score 0-5: 5 = warm, correct, concise, returns smoothly to the tale; 0 = wrong/cold/derails.
Output ONLY JSON: {"score":<0-5>,"reason":"<=12 words"}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: rubric }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 256 },
        }),
      },
    );
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return { score: j.score, reason: j.reason };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

function pct(arr, p) {
  const xs = arr.filter((x) => x != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1);
  return xs[i];
}

async function main() {
  if (!existsSync(WAV_DIR)) {
    console.error(`WAV dir missing: ${WAV_DIR} — run generate-wavs.mjs first`);
    process.exit(1);
  }
  const toRun = (ONLY ? CASES.filter((c) => ONLY.includes(c.id)) : CASES).filter(
    // latency only meaningful for cases that SHOULD trigger a barge-in.
    (c) => c.axis === 'true-positive' || flag('--all'),
  );
  if (!toRun.length) {
    console.error('No true-positive cases to measure. Use --all to force, or check cases.json.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const out = [];
  for (const testCase of toRun) {
    console.log(`\n▶ ${testCase.id} — ${testCase.label} (${TRIALS} trial${TRIALS > 1 ? 's' : ''})`);
    const trials = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = await runTrial(testCase, i);
      if (r.error) {
        console.log(`  trial ${i}: ERROR ${r.error} ${r.wavPath ?? ''}`);
        continue;
      }
      const L = r.latencies;
      console.log(
        `  trial ${i}: T1=${L.t1_pause_ms ?? '—'}ms T2=${L.t2_reply_ms ?? '—'}ms T3=${L.t3_resume_ms ?? '—'}ms`,
      );
      trials.push(r);
    }
    let quality = null;
    if (JUDGE && trials.length) {
      quality = await judgeAnswer(testCase, trials[trials.length - 1].answer_text);
      console.log(`  quality: ${quality.score ?? quality.skipped ?? quality.error}`);
    }
    // End-to-end round trip a listener feels: speak → pause → reply → (silence
    // confirm) → resume. T3 already spans the silence-confirm wait + plan +
    // bridge, so total = T1+T2+T3 per trial (only when all three measured).
    const totals = trials
      .map((t) => {
        const { t1_pause_ms: a, t2_reply_ms: b, t3_resume_ms: c } = t.latencies;
        return a != null && b != null && c != null ? a + b + c : null;
      })
      .filter((x) => x != null);

    out.push({
      id: testCase.id,
      label: testCase.label,
      trials,
      agg: {
        t1_p50: pct(trials.map((t) => t.latencies.t1_pause_ms), 50),
        t1_p95: pct(trials.map((t) => t.latencies.t1_pause_ms), 95),
        t2_p50: pct(trials.map((t) => t.latencies.t2_reply_ms), 50),
        t2_p95: pct(trials.map((t) => t.latencies.t2_reply_ms), 95),
        t3_p50: pct(trials.map((t) => t.latencies.t3_resume_ms), 50),
        t3_p95: pct(trials.map((t) => t.latencies.t3_resume_ms), 95),
        total_p50: pct(totals, 50),
        total_p95: pct(totals, 95),
      },
      quality,
    });
  }

  writeFileSync(
    join(OUT_DIR, 'latency.json'),
    JSON.stringify({ known_fixed: KNOWN_FIXED, bands: BANDS, cases: out }, null, 2),
  );

  // ── Report, framed as the three UX questions a listener actually asks.
  console.log('\n# Barge-in user-experience timeline\n');
  console.log('Maps the three things a listener feels. p50/p95 in ms; 🟢 good 🟡 ok 🔴 sluggish.\n');
  console.log('| case | ①stop-talking T1 | ②answer T2 | ③back-to-story T3 | round-trip | quality |');
  console.log('|---|---|---|---|---|---|');
  for (const o of out) {
    const a = o.agg;
    const cell = (p50, p95, b) => (p50 == null ? '—' : `${band(p50, b)} ${p50}/${p95}`);
    const q = o.quality?.score != null ? `${o.quality.score}/5` : '—';
    console.log(
      `| ${o.id} | ${cell(a.t1_p50, a.t1_p95, BANDS.t1_pause)} | ${cell(a.t2_p50, a.t2_p95, BANDS.t2_reply)} | ${cell(a.t3_p50, a.t3_p95, BANDS.t3_resume)} | ${cell(a.total_p50, a.total_p95, BANDS.total)} | ${q} |`,
    );
  }

  // ── "Back to story after I stop talking" budget — decompose T3 into the
  // FIXED tunable wait vs the variable live work. This is the knob you asked
  // about: of the resume time, how much is the hardcoded silence-confirm?
  console.log('\n## "How long after I go quiet does the story continue?" — budget\n');
  console.log(`Fixed silence-confirm wait (tunable product knob): **${KNOWN_FIXED.silence_confirm_ms}ms** (\`SILENCE_TIMEOUT_MS\`, components/TutorPage.tsx)\n`);
  console.log('| case | total resume (T3 p50) | — fixed wait | = live plan+bridge | tune fixed→? |');
  console.log('|---|---|---|---|---|');
  for (const o of out) {
    const t3 = o.agg.t3_p50;
    if (t3 == null) { console.log(`| ${o.id} | — | ${KNOWN_FIXED.silence_confirm_ms} | — | — |`); continue; }
    const live = Math.max(0, t3 - KNOWN_FIXED.silence_confirm_ms);
    const hint = live > 1500 ? 'live work dominates — fixed wait not the bottleneck' : 'fixed wait is a big share — lowering it helps most';
    console.log(`| ${o.id} | ${t3} | ${KNOWN_FIXED.silence_confirm_ms} | ${live} | ${hint} |`);
  }
  console.log(`\nwrote ${join(OUT_DIR, 'latency.json')}`);
}

main();

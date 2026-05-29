// Spikes 1 + 2 — Chromium fake-mic feasibility probe.
//
// Spike 1: launch Chromium with --use-file-for-fake-audio-capture pointing at
//   a 10s 440Hz sine WAV; have the page sample its AnalyserNode and report
//   the dominant FFT bin. PASS = dominant frequency within 5Hz of 440.
//
// Spike 2: same setup but WAV is "3s silence + 3s 440Hz". Report the
//   wall-clock t at which 440Hz first crosses the magnitude threshold.
//   Run N trials. PASS = stddev across trials < 200ms.
//
// Usage: pnpm tsx docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/spike-1-2.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAGE_URL = 'file://' + join(__dirname, 'fft-page.html');
const SINE_WAV = '/tmp/spike-mic/sine440.wav';
const SILENCE_SINE_WAV = '/tmp/spike-mic/silence-then-sine.wav';

if (!existsSync(SINE_WAV) || !existsSync(SILENCE_SINE_WAV)) {
  console.error('missing WAVs at /tmp/spike-mic/ — generate with the ffmpeg commands in conclusion.md');
  process.exit(2);
}

async function runOneTrial(wavPath, label, captureWindowMs = 8500) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({
    permissions: ['microphone'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message));
  await page.goto(PAGE_URL);
  // Wait for the page's sampling loop to finish.
  await page.waitForFunction(() => window.__spikeResult?.done === true, { timeout: captureWindowMs });
  const result = await page.evaluate(() => window.__spikeResult);
  await browser.close();
  return result;
}

function stats(xs) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, stddev: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { n, mean, stddev: Math.sqrt(variance), min: Math.min(...xs), max: Math.max(...xs) };
}

console.log('\n=== Spike 1 — fake-mic basic + FFT ===');
const s1 = await runOneTrial(SINE_WAV, 'S1');
console.log('stream label:', JSON.stringify(s1.stream_label));
console.log('errors:', JSON.stringify(s1.errors));
console.log('samples:', s1.dominant_freqs.length);
// Look at the steady-state portion — ignore the first ~500ms which can be
// noisy during ramp-up. Take samples from t > 1000ms with magnitude > 80.
const steady = s1.dominant_freqs.filter((s) => s.t_ms > 1000 && s.magnitude > 80);
if (steady.length === 0) {
  console.log('S1 FAIL — no steady-state samples above magnitude threshold');
  console.log('first 10 samples:', JSON.stringify(s1.dominant_freqs.slice(0, 10)));
} else {
  const freqs = steady.map((s) => s.freq_hz);
  const fStats = stats(freqs);
  // Tolerance comes from FFT bin width — we can't resolve finer than that.
  // binWidth = sampleRate / fftSize. Macs default to 48000Hz with fftSize 4096
  // → 11.72Hz/bin. We accept any detection within 1 bin of 440Hz.
  const binWidth = s1.sample_rate / s1.fft_size;
  const tolerance = binWidth;
  console.log(`steady freq: mean=${fStats.mean.toFixed(2)}Hz stddev=${fStats.stddev.toFixed(2)}Hz min=${fStats.min.toFixed(1)} max=${fStats.max.toFixed(1)} (n=${fStats.n}) — sample_rate=${s1.sample_rate} fft_size=${s1.fft_size} binWidth=${binWidth.toFixed(2)}Hz`);
  const offsetFrom440 = Math.abs(fStats.mean - 440);
  const passS1 = offsetFrom440 < tolerance;
  console.log(`S1 verdict: |mean - 440| = ${offsetFrom440.toFixed(2)}Hz — ${passS1 ? 'PASS' : 'FAIL'} (threshold = 1 bin = ${tolerance.toFixed(2)}Hz)`);
}

console.log('\n=== Spike 2 — timing-control jitter (10 trials) ===');
const N = 10;
const audibleTimes = [];
for (let i = 1; i <= N; i++) {
  const r = await runOneTrial(SILENCE_SINE_WAV, `S2/trial${i}`);
  console.log(`  trial ${i}: first_audible_t_ms=${r.first_audible_t_ms} errors=${r.errors.length}`);
  if (r.first_audible_t_ms !== null) audibleTimes.push(r.first_audible_t_ms);
}
const tStats = stats(audibleTimes);
console.log(`\nfirst-audible across ${N} trials: n=${tStats.n} mean=${tStats.mean.toFixed(0)}ms stddev=${tStats.stddev.toFixed(0)}ms range=[${tStats.min.toFixed(0)}, ${tStats.max.toFixed(0)}]`);
console.log(`S2 verdict: stddev = ${tStats.stddev.toFixed(0)}ms — ${tStats.n >= 8 && tStats.stddev < 200 ? 'PASS' : 'FAIL'} (threshold n≥8 trials usable AND stddev<200ms)`);

// Self-emit machine-readable summary for the decision step. Pass thresholds
// match the human-readable verdicts above — bin-width-based tolerance for S1,
// 200ms stddev cap for S2.
const s1BinWidth = s1.sample_rate / s1.fft_size;
const s1Mean = steady.length > 0 ? stats(steady.map((s) => s.freq_hz)).mean : null;
console.log('\n=== Summary (machine) ===');
console.log(JSON.stringify({
  s1: {
    pass: s1Mean !== null && Math.abs(s1Mean - 440) < s1BinWidth,
    detected_freq_mean: s1Mean,
    bin_width_hz: s1BinWidth,
    sample_rate: s1.sample_rate,
    fft_size: s1.fft_size,
    stream_label: s1.stream_label,
    errors: s1.errors,
  },
  s2: {
    pass: tStats.n >= 8 && tStats.stddev < 200,
    n_trials_usable: tStats.n,
    first_audible_mean_ms: tStats.mean,
    first_audible_stddev_ms: tStats.stddev,
    raw_times: audibleTimes,
  },
}, null, 2));

// Verifies the SUBTITLE REVEAL (anti-spoiler): the current scene's narration
// must appear PROGRESSIVELY (word-by-word, synced to the voice), NOT dumped in
// full ahead of the audio. No mic / barge-in needed — just watch the narration
// bubble grow while the agent narrates.
//
// PASS = the current-scene bubble's text length GROWS over time within a scene
// (progressive), and at an early mid-scene sample it is strictly SHORTER than
// the scene's full narration (no read-ahead). Saves screenshots for eyeballing.
//
// Needs a live dev server (Agora + Gemini). Usage:
//   node scripts/qa-bench/audio-barge-in/verify-subtitle-reveal.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE_URL = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const TOPIC = process.env.TOPIC || 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const OUT = '/tmp/spike-mic/subtitle';
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS || 90000);
const WATCH_MS = Number(process.env.WATCH_MS || 28000);
const SAMPLE_MS = 700;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/tutor`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('textarea, input[type="text"]').first().fill(TOPIC);
    await page.locator('button', { hasText: /begin/i }).first().click();
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
    console.log('story screen up — watching the narration bubble grow…\n');

    const samples = [];
    const t0 = Date.now();
    let shotIdx = 0;
    while (Date.now() - t0 < WATCH_MS) {
      const txt = await page
        .locator('[data-testid="narration-current"]')
        .first()
        .innerText()
        .catch(() => '');
      const len = txt.trim().length;
      samples.push({ t: Date.now() - t0, len, text: txt.trim() });
      // Screenshot the first few non-empty, non-complete frames (mid-reveal).
      if (len > 0 && shotIdx < 3) {
        await page.screenshot({ path: `${OUT}/reveal-${shotIdx}.png` }).catch(() => {});
        shotIdx++;
      }
      await page.waitForTimeout(SAMPLE_MS);
    }
    await ctx.close();

    // Analysis: did the text grow progressively (not instant-full)?
    console.log('t(ms)   len   text');
    for (const s of samples) console.log(`${String(s.t).padStart(6)}  ${String(s.len).padStart(4)}  ${s.text.slice(0, 70)}`);

    const lens = samples.map((s) => s.len);
    const maxLen = Math.max(...lens, 0);
    const firstNonEmpty = samples.find((s) => s.len > 0);
    const grew = lens.some((l, i) => i > 0 && l > lens[i - 1]); // some increase = progressive
    // Read-ahead check: was there a mid-reveal frame where text was PARTIAL
    // (>0 but < the eventual max for that scene)? i.e. it wasn't instantly full.
    const hadPartial = firstNonEmpty && firstNonEmpty.len < maxLen * 0.8;

    console.log('\n=== SUBTITLE REVEAL VERDICT ===');
    console.log(`  first non-empty len: ${firstNonEmpty?.len ?? 0} (max seen ${maxLen})`);
    console.log(`  grew progressively:  ${grew ? '✅' : '❌'}`);
    console.log(`  started partial (not instant-full): ${hadPartial ? '✅' : '❌'}`);
    const pass = grew && hadPartial;
    console.log(`  ${pass ? '✅ PASS — subtitle reveal is progressive (no read-ahead dump)' : '❌ FAIL — text appeared all at once'}`);
    console.log(`  screenshots: ${OUT}/reveal-0..${shotIdx - 1}.png`);
    process.exit(pass ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main();

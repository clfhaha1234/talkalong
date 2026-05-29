// Spike 3 — does the full agora-voice-demo pipeline accept fake-mic input?
//
// What it does:
//   1. Launches headed (visible) Chromium with the same fake-mic flags that
//      Spike 1+2 proved deliver a clean, deterministic audio stream.
//   2. Navigates to the dev server (assumed running at --base-url).
//   3. Records every console message, every network request to /api/*, and
//      every WebSocket frame — gives the user full visibility into what the
//      Agora SDK + the demo's own server did with the fake mic.
//   4. Screenshots at fixed checkpoints so a static PR comment can show the
//      whole journey.
//
// What the user does:
//   1. In one terminal: pnpm dev   (in agora-voice-demo)
//   2. Wait for "Ready in Xs"; confirm http://localhost:3000 loads in a real browser
//   3. In another terminal: bash docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/generate-test-wavs.sh
//   4. Then: node docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/spike-3-e2e.mjs
//   5. Watch the headed browser run for ~45s — it will auto-click the start
//      button if it finds one, then wait while the fake "What is moss?"
//      plays out of the simulated mic.
//   6. When the script exits: open the screenshots + network log it wrote
//      to /tmp/spike-mic/spike-3-output/ and tell me what you saw.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE_URL = get('--base-url', 'http://localhost:3000');
const WAV = get('--wav', '/tmp/spike-mic/question-padded-30s.wav');
const OUT_DIR = get('--out', '/tmp/spike-mic/spike-3-output');
const HEADLESS = args.includes('--headless');

if (!existsSync(WAV)) {
  console.error(`WAV not found: ${WAV}`);
  console.error('Run docs/experiments/2026-05-30-fake-mic-spike/spike-scripts/generate-test-wavs.sh first.');
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

console.log(`base_url=${BASE_URL}`);
console.log(`wav=${WAV}`);
console.log(`out_dir=${OUT_DIR}`);
console.log(`headless=${HEADLESS}`);

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();

// Observability — capture EVERYTHING.
const consoleMessages = [];
page.on('console', (m) => {
  const entry = { t: Date.now(), type: m.type(), text: m.text() };
  consoleMessages.push(entry);
  console.log(`[browser/${entry.type}]`, entry.text.slice(0, 200));
});
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message);
  consoleMessages.push({ t: Date.now(), type: 'pageerror', text: e.message });
});

const apiRequests = [];
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/api/') || url.includes('agora') || url.includes('ws://') || url.includes('wss://')) {
    const entry = { t: Date.now(), method: req.method(), url, post_body: req.postData()?.slice(0, 500) };
    apiRequests.push(entry);
    console.log(`[req] ${entry.method} ${url}`);
  }
});
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('/api/') && res.status() >= 400) {
    console.log(`[!! response ${res.status()}] ${url}`);
  }
});
page.on('websocket', (ws) => {
  console.log('[ws-open]', ws.url());
  ws.on('framesent', (f) => { try { console.log('[ws-send]', String(f.payload).slice(0, 120)); } catch {} });
  ws.on('framereceived', (f) => { try { console.log('[ws-recv]', String(f.payload).slice(0, 120)); } catch {} });
  ws.on('close', () => console.log('[ws-close]', ws.url()));
});

const screenshot = async (name) => {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  console.log(`[screenshot] ${path}`);
};

console.log('\n→ navigating');
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
await screenshot('01-landing');

// Try to find and click the Start / Try-it-Now / Begin button. The button has
// aria-label that contains "conversation" — that's our most stable hook. If
// the UI differs in your branch, edit this selector and report back.
console.log('\n→ looking for start CTA');
const startSelectors = [
  'button[aria-label*="conversation" i]',
  'button:has-text("Try it Now")',
  'button:has-text("Start")',
  'button:has-text("Begin")',
  '[role="button"]:has-text("Start")',
];
let clicked = false;
for (const sel of startSelectors) {
  const btn = page.locator(sel).first();
  if (await btn.count() > 0) {
    console.log(`  found via: ${sel}`);
    try {
      await btn.click({ timeout: 5000 });
      clicked = true;
      console.log(`  clicked.`);
      break;
    } catch (e) {
      console.log(`  click failed: ${e.message}`);
    }
  }
}
if (!clicked) {
  console.log('  !! no start button found — open /tmp/spike-mic/spike-3-output/01-landing.png and tell me what to click');
}
await page.waitForTimeout(3000);
await screenshot('02-after-start-click');

// Now let the fake mic play out — the WAV is "What is moss?" followed by
// padding. We expect (over the next 20-25s) to see:
//   - an Agora WS connection open
//   - the SDK send audio frames
//   - the demo's server return STT text containing "moss"
//   - the agent emit reply tokens
// All of which will land in apiRequests / consoleMessages / ws logs below.
console.log('\n→ observing for 30s (fake mic plays out)');
for (let i = 5; i <= 30; i += 5) {
  await page.waitForTimeout(5000);
  await screenshot(`03-t${i}s`);
  console.log(`  t=${i}s — n_console=${consoleMessages.length} n_api=${apiRequests.length}`);
}

// Final state — dump everything to disk.
const summary = {
  base_url: BASE_URL,
  wav: WAV,
  started_at: new Date().toISOString(),
  clicked_start: clicked,
  console_messages: consoleMessages,
  api_requests: apiRequests,
};
writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2));
writeFileSync(`${OUT_DIR}/console.txt`, consoleMessages.map((m) => `[${m.type}] ${m.text}`).join('\n'));
writeFileSync(`${OUT_DIR}/api-requests.txt`, apiRequests.map((r) => `${r.method} ${r.url}\n  body: ${r.post_body ?? '(none)'}`).join('\n\n'));
console.log(`\n→ wrote ${OUT_DIR}/{summary.json,console.txt,api-requests.txt,*.png}`);

await browser.close();

// Print a quick verdict heuristic so the user has an immediate read-out.
console.log('\n=== quick heuristic ===');
const sawAgoraWs = consoleMessages.some((m) => /agora|rtc/i.test(m.text)) ||
                   apiRequests.some((r) => /agora/i.test(r.url));
const sawSttText = consoleMessages.some((m) => /moss|transcript|stt/i.test(m.text));
const sawAgentReply = consoleMessages.some((m) => /agent|reply|tutor|narrator/i.test(m.text));
console.log(`saw_agora_traffic: ${sawAgoraWs ? 'YES' : 'no'}`);
console.log(`saw_stt_or_moss: ${sawSttText ? 'YES' : 'no'}`);
console.log(`saw_agent_response: ${sawAgentReply ? 'YES' : 'no'}`);
console.log('\nReport back: paste the quick-heuristic block + the screenshots/summary.json so we can decide whether to build the full harness.');

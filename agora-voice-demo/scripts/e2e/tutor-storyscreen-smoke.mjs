// Tier-2 browser smoke for StoryScreen — the REAL-browser layout coverage that
// Tier 1 (jsdom render tests) structurally can't provide. jsdom has no layout
// engine, so it can't see the bug class that actually bit us most:
//   - composer pushed off-screen (grid row auto-grew past the 800px stage)
//   - feed not scrollable (minHeight:0 missing)
//   - content rendered but invisible / clipped under the ScalingStage transform
//
// It drives /tutor/preview (StoryScreen + fixtures inside the real ScalingStage,
// no Agora/API/mic), then asserts geometry via getBoundingClientRect:
//   ✓ teacher narration actually rendered
//   ✓ the composer is present AND fully within the viewport (not clipped off-bottom)
//   ✓ the voice/keyboard toggle is present and switches the composer in a real DOM
//   ✓ the feed is a scrollable region (scrollHeight > clientHeight or fits)
//   ✓ no console / page errors
//
// Run against an already-running dev server:
//   E2E_BASE_URL=http://localhost:3000 node scripts/e2e/tutor-storyscreen-smoke.mjs

import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const URL = `${BASE}/tutor/preview`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  check('GET /tutor/preview responds 200', resp?.status() === 200, `status=${resp?.status()}`);

  // Narration teacher bubble rendered.
  await page.waitForSelector('text=/time itself that must bend/i', { timeout: 20000 });
  check('teacher narration rendered', true);

  // ── Composer is present AND within the viewport (the "invisible composer" bug) ──
  const voiceBar = page.getByText(/just speak to interrupt/i).first();
  await voiceBar.waitFor({ timeout: 10000 });
  const composerBox = await voiceBar.boundingBox();
  const vp = page.viewportSize();
  const withinViewport =
    !!composerBox &&
    composerBox.y >= 0 &&
    composerBox.y + composerBox.height <= vp.height + 1; // +1 for sub-pixel
  check(
    'composer is fully within the viewport (not clipped off-bottom)',
    withinViewport,
    composerBox
      ? `composer bottom=${Math.round(composerBox.y + composerBox.height)} vs vh=${vp.height}`
      : 'composer not found',
  );

  // ── Toggle present + switches composer in a real DOM ──
  const voiceBtn = page.getByTitle('Voice');
  const kbBtn = page.getByTitle('Keyboard');
  check('voice/keyboard toggle present', (await voiceBtn.count()) === 1 && (await kbBtn.count()) === 1);

  await kbBtn.click();
  const textbox = page.getByRole('textbox');
  await textbox.waitFor({ timeout: 5000 });
  check('clicking Keyboard reveals the text input', (await textbox.count()) >= 1);
  // And the text input is itself within the viewport (not clipped).
  const tbBox = await textbox.boundingBox();
  check(
    'text input is within the viewport',
    !!tbBox && tbBox.y + tbBox.height <= vp.height + 1,
    tbBox ? `input bottom=${Math.round(tbBox.y + tbBox.height)}` : 'no input',
  );
  await voiceBtn.click();
  check('clicking Voice restores the voice composer', (await page.getByText(/just speak to interrupt/i).count()) >= 1);

  // ── The conversation feed is a real scroll region ──
  const feedMetrics = await page.evaluate(() => {
    // The feed is the scrollable column holding the teacher bubbles. Find the
    // nearest scrollable ancestor of a narration bubble. querySelectorAll is
    // pre-order, so among all divs containing the text the LAST one is the
    // innermost (the bubble itself), not an outer ancestor.
    const matches = Array.from(document.querySelectorAll('div')).filter((d) =>
      /time itself that must bend/i.test(d.textContent || ''),
    );
    const bubble = matches[matches.length - 1];
    let el = bubble;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > 0) {
        return { found: true, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
      el = el.parentElement;
    }
    return { found: false };
  });
  check('feed is a scrollable region', feedMetrics.found === true, JSON.stringify(feedMetrics));

  check(
    'no console/page errors',
    consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '',
  );
} catch (err) {
  check('smoke script ran without throwing', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);

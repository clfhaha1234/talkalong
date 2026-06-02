// Tier-2 browser smoke for StoryScreen — the REAL-browser layout coverage that
// Tier 1 (jsdom render tests) structurally can't provide. jsdom has no layout
// engine, so it can't see the bug class that actually bit us most:
//   - composer pushed off-screen (grid row auto-grew past the 800px stage)
//   - feed not scrollable (minHeight:0 missing)
//   - content rendered but invisible / clipped under the ScalingStage transform
//
// It drives /tutor/preview across every state VARIANT (reading / muted /
// listening / paused / finished / broken-image — StoryScreen + fixtures inside the real
// ScalingStage, no Agora/API/mic) and asserts geometry via getBoundingClientRect
// for each: the variant's composer is present AND fully within the viewport,
// narration rendered, feed scrollable, no console/page errors. The toggle is
// exercised in the reading variant.
//
// Run against an already-running dev server:
//   E2E_BASE_URL=http://localhost:3000 node scripts/e2e/tutor-storyscreen-smoke.mjs

import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';

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

// Is the locator's box fully inside the viewport (not clipped off-bottom/top)?
async function withinViewport(locator) {
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  if (!box) return { ok: false, detail: 'not found' };
  const ok = box.y >= -1 && box.y + box.height <= vp.height + 1;
  return { ok, detail: `bottom=${Math.round(box.y + box.height)} vs vh=${vp.height}` };
}

// The visible composer affordance differs per state.
const VARIANTS = [
  { name: 'reading', composer: /just speak to interrupt/i },
  { name: 'muted', composer: /muted — tap to talk/i },
  { name: 'listening', composer: /what is light actually made of/i },
  { name: 'paused', composer: /just speak to interrupt/i },
  { name: 'finished', composer: /just speak to interrupt/i },
  { name: 'broken-image', composer: /just speak to interrupt/i },
];

try {
  for (const v of VARIANTS) {
    const before = consoleErrors.length;
    const resp = await page.goto(`${BASE}/tutor/preview?variant=${v.name}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    check(`[${v.name}] GET 200`, resp?.status() === 200, `status=${resp?.status()}`);

    // Story screen mounted. In listening/paused states the current subtitle can
    // legitimately pause, so use the stable progress dots as the page-ready
    // signal and assert narration text only in the reading state.
    await page.getByTestId('scene-dots').waitFor({ timeout: 20000 });
    if (v.name === 'reading') {
      await page.waitForSelector('text=/time itself that must bend/i', { timeout: 20000 });
    }

    // The variant's composer affordance is present AND within the viewport.
    const composer = page.getByText(v.composer).first();
    await composer.waitFor({ timeout: 10000 });
    const vv = await withinViewport(composer);
    check(`[${v.name}] composer present + within viewport`, vv.ok, vv.detail);

    // finished must NOT offer the continue-the-story CTA.
    if (v.name === 'finished') {
      check(
        '[finished] no "continue the story" CTA',
        (await page.getByText(/continue the story/i).count()) === 0,
      );
    }
    if (v.name === 'broken-image') {
      await page.waitForTimeout(1500);
      check(
        '[broken-image] failed illustration falls back instead of showing browser alt text',
        (await page.getByText(/Illustration for/i).count()) === 0,
      );
    }

    const newErrors = consoleErrors.slice(before).filter((msg) => {
      if (v.name !== 'broken-image') return true;
      return !/definitely-missing-field-regression\.jpg|404 \(Not Found\)/i.test(msg);
    });
    check(`[${v.name}] no console/page errors`, newErrors.length === 0,
      newErrors.slice(0, 2).join(' | '));
  }

  // ── Toggle + feed-scroll geometry (exercise once, on the reading variant) ──
  await page.goto(`${BASE}/tutor/preview?variant=reading`, { waitUntil: 'networkidle' });
  await page.getByTestId('scene-dots').waitFor({ timeout: 20000 });

  const kbBtn = page.getByTitle('Keyboard');
  check('toggle present (Voice + Keyboard)', (await page.getByTitle('Voice').count()) === 1 && (await kbBtn.count()) === 1);
  await kbBtn.click();
  const textbox = page.getByRole('textbox');
  await textbox.waitFor({ timeout: 5000 });
  const tv = await withinViewport(textbox);
  check('keyboard mode: text input revealed + within viewport', tv.ok, tv.detail);
  await textbox.fill('Why did the clock seem slower?');
  await page.getByTitle('Ask').click();
  await page.waitForSelector('text=/Why did the clock seem slower/i', { timeout: 5000 });
  await page.waitForSelector('text=/motion changes how time is measured/i', { timeout: 5000 });
  check('preview typed QA appends a user bubble + answer bubble', true);
  await page.getByTitle('Voice').click();
  check('voice mode restored', (await page.getByText(/just speak to interrupt/i).count()) >= 1);

  const feed = await page.evaluate(() => {
    const matches = Array.from(document.querySelectorAll('div')).filter((d) =>
      /time itself that must bend/i.test(d.textContent || ''),
    );
    let el = matches[matches.length - 1];
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > 0) {
        return { found: true, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
      el = el.parentElement;
    }
    return { found: false };
  });
  check('feed is a scrollable region', feed.found === true, JSON.stringify(feed));
} catch (err) {
  check('smoke script ran without throwing', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);

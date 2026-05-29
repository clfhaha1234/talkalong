// Browser smoke e2e for the /tutor entry screen.
//
// This is a voice app: the full barge-in flow needs live Agora RTC/RTM + a real
// microphone, which can't run headless in CI. So the browser e2e covers the
// deterministic UI surface — the InputScreen renders, accepts a topic, and
// exposes the presets + Begin control — which catches build/render/hydration
// regressions of the tutor entry. The Q&A → Chinese-resume logic (the path the
// user's bug touched) is covered separately by the orchestrator integration
// test in lib/orchestrator/index.qa-resume.test.ts.
//
// Uses the bare `playwright` library (the repo has no @playwright/test runner).
// Run against an already-running dev server:
//   E2E_BASE_URL=http://localhost:3100 node scripts/e2e/tutor-input-smoke.mjs

import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const URL = `${BASE}/tutor`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('GET /tutor responds 200', resp?.status() === 200, `status=${resp?.status()}`);

  // Headline (text is split across spans, so match the whole rendered string).
  await page.waitForSelector('h1', { timeout: 20000 });
  const h1 = (await page.locator('h1').first().innerText()).replace(/\s+/g, ' ').trim();
  check('headline asks what to learn', /what shall we.*learn.*tonight/i.test(h1), JSON.stringify(h1));

  // Topic textarea is present and typeable.
  const ta = page.locator('textarea[placeholder*="topic" i]');
  await ta.waitFor({ timeout: 10000 });
  await ta.fill('Why is the sky blue?');
  check('textarea accepts a topic', (await ta.inputValue()) === 'Why is the sky blue?');

  // Begin control present.
  const begin = page.getByRole('button', { name: /begin/i });
  check('Begin button present', (await begin.count()) >= 1);

  // Preset chips render (first three).
  const bodyText = (await page.locator('body').innerText());
  check('shows "or try:" presets', /or try:/i.test(bodyText));
  check('preset "Why we have seasons" present', bodyText.includes('Why we have seasons'));
  check('preset "Photosynthesis" present', bodyText.includes('Photosynthesis'));

  // No console/page errors during render.
  check('no console/page errors on load', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '');
} catch (err) {
  check('smoke script ran without throwing', false, String(err).slice(0, 200));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);

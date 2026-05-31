// Unified tutor evaluation entry — `pnpm eval`.
//
// Runs the whole stack in order, fail-fast:
//   1. vitest run        — node (pure logic) + jsdom (component render) projects
//   2. browser smokes     — tutor-input-smoke + tutor-storyscreen-smoke against a
//                           dev server (reuses one if reachable, else boots+stops one)
//
// Layer map + why Tier 3 (full live Agora session) is deferred: scripts/e2e/README.md
//
// Usage:
//   pnpm eval                                  # boots its own dev server if needed
//   E2E_BASE_URL=http://localhost:3000 pnpm eval   # reuse a running server
//   pnpm eval --no-e2e                         # vitest only (skip browser layer)

import { spawn } from 'node:child_process';

const SKIP_E2E = process.argv.includes('--no-e2e');
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

async function isUp(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok || r.status === 200;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function section(title) {
  console.log(`\n\x1b[1m━━━ ${title} ━━━\x1b[0m`);
}

let exitCode = 0;

// ── 1. vitest (node + jsdom) ────────────────────────────────────────────────
section('vitest (node + jsdom render)');
const vitestCode = await run('pnpm', ['vitest', 'run']);
if (vitestCode !== 0) {
  console.error('\n✗ vitest failed — stopping before the browser layer.');
  process.exit(vitestCode);
}

if (SKIP_E2E) {
  console.log('\n✓ vitest passed. (--no-e2e: skipping browser smokes.)');
  process.exit(0);
}

// ── 2. browser smokes (manage a dev server if needed) ───────────────────────
section('browser smokes');
let devProc = null;
let startedServer = false;

if (await isUp(`${BASE}/`)) {
  console.log(`Reusing dev server at ${BASE}`);
} else {
  console.log(`No server at ${BASE} — booting \`pnpm dev\`…`);
  devProc = spawn('pnpm', ['dev'], { stdio: 'ignore', detached: false });
  startedServer = true;
  const ready = await waitUntilUp(`${BASE}/`, 90000);
  if (!ready) {
    console.error('✗ dev server did not become ready in 90s.');
    if (devProc) devProc.kill('SIGTERM');
    process.exit(1);
  }
  console.log('Dev server ready.');
}

try {
  for (const script of ['tutor-input-smoke.mjs', 'tutor-storyscreen-smoke.mjs']) {
    console.log(`\n→ ${script}`);
    const code = await run('node', [`scripts/e2e/${script}`], { env: { ...process.env, E2E_BASE_URL: BASE } });
    if (code !== 0) exitCode = code;
  }
} finally {
  if (startedServer && devProc) {
    devProc.kill('SIGTERM');
    console.log('\nStopped the dev server we started.');
  }
}

console.log(exitCode === 0 ? '\n\x1b[32m✓ eval stack green\x1b[0m' : '\n\x1b[31m✗ eval stack had failures\x1b[0m');
process.exit(exitCode);

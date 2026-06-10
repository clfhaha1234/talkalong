// Cross-stack live voice regression suite for /tutor and /stepfun.
//
// This is intentionally opt-in: it drives real browser sessions and can consume
// Agora / StepFun / LLM quota. Use it after voice-state-machine changes, before
// deploys, and when comparing the two implementations.
//
// Examples:
//   pnpm test:voice:cross
//   STACKS=stepfun pnpm test:voice:cross
//   CASES=tutor:typed-sequential pnpm test:voice:cross
//   TUTOR_URL=https://talkalong-tutor.onrender.com/tutor \
//   STEPFUN_URL=https://talkalong-tutor.onrender.com/stepfun pnpm test:voice:cross

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const ALL_CASES = [
  {
    id: 'tutor:typed-sequential',
    stack: 'tutor',
    note: 'same-session repeated typed interrupts; catches stale branch/transcript/resume bugs',
    cmd: ['node', 'scripts/qa-bench/audio-barge-in/verify-typed-qa-sequential.mjs'],
    env: () => ({
      BARGE_BASE_URL: tutorBaseWithoutPath(),
    }),
  },
  {
    id: 'tutor:voice-barge',
    stack: 'tutor',
    note: 'fake-mic spoken interruption through Agora-managed STT/LLM/TTS',
    cmd: ['node', 'scripts/qa-bench/audio-barge-in/tutor-barge-in-e2e.mjs'],
    env: () => ({
      TUTOR_URL: tutorPageUrl(),
    }),
  },
  {
    id: 'stepfun:stream',
    stack: 'stepfun',
    note: 'server stream contract, TTFA, back-channel, hold turns',
    cmd: ['node', '--import', 'tsx', 'scripts/stepfun/verify-stream.ts'],
    env: () => ({
      PROBE_BASE: stepfunBaseWithoutPath(),
    }),
  },
  {
    id: 'stepfun:followup-window',
    stack: 'stepfun',
    note: 'QA answer must not be preempted by narration resume',
    cmd: ['node', 'scripts/stepfun/stepfun-followup-window-e2e.mjs'],
    env: () => ({
      STEPFUN_URL: process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001/stepfun',
    }),
  },
  {
    id: 'stepfun:multi-barge',
    stack: 'stepfun',
    note: 'multiple same-session spoken interruptions',
    cmd: ['node', 'scripts/stepfun/stepfun-multi-barge-e2e.mjs'],
    env: () => ({
      STEPFUN_URL: process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001/stepfun',
    }),
  },
  {
    id: 'stepfun:rapid-multi-barge',
    stack: 'stepfun',
    note: 'second question lands mid-answer; resume must survive back-to-back interrupts',
    cmd: ['node', 'scripts/stepfun/stepfun-rapid-multi-barge-e2e.mjs'],
    env: () => ({
      STEPFUN_URL: process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3001/stepfun',
    }),
  },
];

function stepfunBaseWithoutPath() {
  const raw = process.env.STEPFUN_URL ?? process.env.BARGE_BASE_URL ?? process.env.PROBE_BASE ?? 'http://localhost:3001';
  return raw.replace(/\/stepfun\/?$/, '').replace(/\/$/, '');
}

function tutorBaseWithoutPath() {
  const raw = process.env.TUTOR_URL ?? process.env.BARGE_BASE_URL ?? 'http://localhost:3000';
  return raw.replace(/\/tutor\/?$/, '').replace(/\/$/, '');
}

function tutorPageUrl() {
  const base = tutorBaseWithoutPath();
  return `${base}/tutor`;
}

function selectedStacks() {
  return new Set(
    (process.env.STACKS ?? 'tutor,stepfun')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function selectedCaseIds() {
  const raw = process.env.CASES;
  if (!raw) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function checkPrereqs() {
  const missing = [];
  if (!existsSync(join(ROOT, 'node_modules/playwright'))) missing.push('node_modules/playwright');
  for (const bin of ['say', 'ffmpeg']) {
    // Keep this shell-free so the harness behaves the same under CI runners.
    const path = (process.env.PATH ?? '')
      .split(':')
      .map((dir) => join(dir, bin))
      .find((p) => existsSync(p));
    if (!path) missing.push(bin);
  }
  if (missing.length) {
    console.warn(`[cross] missing optional runtime prerequisites: ${missing.join(', ')}`);
    console.warn('[cross] the affected fake-mic cases will fail until they are installed.');
  }
}

function runCase(c) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...c.env() };
    const started = Date.now();
    console.log(`\n========== ${c.id} ==========`);
    console.log(c.note);
    console.log(`$ ${c.cmd.join(' ')}`);
    const child = spawn(c.cmd[0], c.cmd.slice(1), {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('close', (code, signal) => {
      const ms = Date.now() - started;
      resolve({ id: c.id, code: code ?? 1, signal, ms });
    });
  });
}

async function main() {
  checkPrereqs();
  const stacks = selectedStacks();
  const caseIds = selectedCaseIds();
  const cases = ALL_CASES.filter((c) => stacks.has(c.stack) && (!caseIds || caseIds.has(c.id)));
  if (!cases.length) {
    throw new Error(
      `no cases selected; STACKS=${[...stacks].join(',') || '(empty)'} CASES=${caseIds ? [...caseIds].join(',') : '(all)'}`,
    );
  }

  console.log('[cross] selected cases:');
  for (const c of cases) console.log(`  - ${c.id}`);
  console.log('');

  const results = [];
  for (const c of cases) {
    results.push(await runCase(c));
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n========== cross-stack voice verdict ==========');
  for (const r of results) {
    const seconds = (r.ms / 1000).toFixed(1);
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.id} (${seconds}s)`);
  }
  console.log(failed.length ? `\nFAIL - ${failed.length}/${results.length} cases failed` : '\nPASS - tutor + StepFun voice regressions clean');
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[cross] fatal:', err);
  process.exit(1);
});

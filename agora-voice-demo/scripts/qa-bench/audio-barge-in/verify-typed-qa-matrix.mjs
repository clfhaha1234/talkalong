// Multi-case typed-QA matrix for the manual bugs that single-shot benchmarks
// missed. This is still cheaper than fake-mic voice E2E, but probes the same
// branch/answer/resume path with timing and answer-shape variation.
//
//   BARGE_BASE_URL=https://talkalong-tutor.onrender.com pnpm test:e2e:typed:matrix
//   TYPED_MATRIX_TRIALS=3 BARGE_BASE_URL=... pnpm test:e2e:typed:matrix

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-typed-qa.mjs', import.meta.url));
const trials = Number(process.env.TYPED_MATRIX_TRIALS || 1);

const cases = [
  {
    id: 'early-opener',
    note: 'Greeting/opening while narration is live must be welcomed, not ignored or teased.',
    env: {
      QUESTION: 'Hello? Can you hear me?',
      EXPECT: '',
      ANSWER_KIND: 'opener',
      NARRATE_MS: '1000',
      MIN_QA_POST_AFTER_REPLY_MS: '2500',
    },
  },
  {
    id: 'early-fact-branch',
    note: 'An early factual question may defer if unrevealed, but must still branch, answer, and resume after the answer window.',
    env: {
      QUESTION: 'What is the name of the cat?',
      EXPECT: '',
      ANSWER_KIND: 'any',
      ALLOW_TEASE: '1',
      NARRATE_MS: '1000',
      MIN_QA_POST_AFTER_REPLY_MS: '2500',
    },
  },
  {
    id: 'late-fact-answer',
    note: 'Once context has been read, the same factual question must answer directly.',
    env: {
      QUESTION: 'What is the name of the cat?',
      EXPECT: 'pemberley',
      ANSWER_KIND: 'factual',
      NARRATE_MS: '5000',
      MIN_QA_POST_AFTER_REPLY_MS: '2500',
    },
  },
];

let failures = 0;

for (const c of cases) {
  for (let i = 1; i <= trials; i += 1) {
    console.log(`\n========== typed matrix: ${c.id} trial ${i}/${trials} ==========`);
    console.log(c.note);
    const result = spawnSync(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, ...c.env },
    });
    if (result.status !== 0) {
      failures += 1;
      console.log(`❌ ${c.id} trial ${i} failed with exit ${result.status}`);
    } else {
      console.log(`✅ ${c.id} trial ${i} passed`);
    }
  }
}

console.log('\n========== typed matrix verdict ==========');
console.log(`cases=${cases.length} trials=${trials} failures=${failures}`);
if (failures > 0) {
  console.log('❌ FAIL — typed QA matrix found a regression');
  process.exit(1);
}

console.log('✅ PASS — typed QA matrix clean');

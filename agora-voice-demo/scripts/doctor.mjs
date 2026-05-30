import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, '.env.local');
const envExamplePath = path.join(projectRoot, '.env.example');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const majorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
if (Number.isNaN(majorVersion) || majorVersion < 22) {
  fail(`Node.js 22 or newer is required. Current version: ${process.versions.node}`);
}

if (!process.env.npm_config_user_agent?.includes('pnpm')) {
  fail('Run this repo with pnpm so installs and scripts stay consistent.');
}

if (!fs.existsSync(envExamplePath)) {
  fail('Missing .env.example. Restore the tracked template before continuing.');
}

if (!fs.existsSync(envPath)) {
  fail('Missing .env.local. Copy .env.example to .env.local before running the app.');
}

const envContents = fs.readFileSync(envPath, 'utf8');
const hasValue = (key) => new RegExp(`^${key}=.+$`, 'm').test(envContents);

// Hard requirement (both the /tutor storybook AND the legacy / conversation demo
// mint Agora join tokens from these — nothing runs without them).
for (const key of ['NEXT_PUBLIC_AGORA_APP_ID', 'NEXT_AGORA_APP_CERTIFICATE']) {
  if (!hasValue(key)) {
    fail(`.env.local is missing a value for ${key}`);
  }
}

// Warn (don't fail) on GOOGLE_API_KEY: the /tutor storybook needs it for lesson
// generation (script + illustrations + resume planner), but the legacy / demo
// runs Agora-only. Without it /tutor still loads but falls back to a plain,
// image-less English story — so flag it here rather than let it surprise you.
if (!hasValue('GOOGLE_API_KEY')) {
  console.warn(
    'Warning: GOOGLE_API_KEY is not set. The /tutor storybook needs it for lesson\n' +
    '  generation (script, illustrations, resume planner) — without it /tutor\n' +
    '  degrades to a plain English story with no images. The legacy / demo is fine.\n' +
    '  Get a key at https://aistudio.google.com/apikey',
  );
}

// Also enable Conversational AI on the Agora project (App ID + Certificate are
// not enough on their own) — `agora project doctor --deep` checks this; a
// disabled project fails at session start with "401 Invalid token".
console.log('Doctor checks passed');

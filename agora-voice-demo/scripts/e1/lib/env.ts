// Lightweight .env.local loader. Reads agora-voice-demo/.env.local so the
// runner picks up the same Agora App ID + Cert + Gemini key that the Next.js
// app uses, without depending on dotenv as a separate npm dep.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Resolve repo root from this file: scripts/e1/lib/env.ts -> ../../..
const repoRoot = join(__dirname, '..', '..', '..');
loadEnvFile(join(repoRoot, '.env.local'));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  agoraAppId: required('NEXT_PUBLIC_AGORA_APP_ID'),
  agoraAppCertificate: required('NEXT_AGORA_APP_CERTIFICATE'),
  geminiApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  agentUid: process.env.NEXT_PUBLIC_AGENT_UID ?? '123456',
};

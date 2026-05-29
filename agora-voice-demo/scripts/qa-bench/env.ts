// Minimal .env.local loader for the QA bench. Only needs GOOGLE_API_KEY.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Honor a non-empty value already in process.env; otherwise load from file.
    if (!process.env[key]) process.env[key] = value;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');
loadEnvFile(join(repoRoot, '.env.local'));
// Some secrets (e.g. OPENAI_API_KEY) live in the outer repo's .env.local.
loadEnvFile(join(repoRoot, '..', '.env.local'));

export const env = {
  geminiApiKey: process.env.GOOGLE_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite',
  // OPENAI_API_KEY in this repo's env points at Z.AI/GLM; use
  // OPENAI_DIRECT_API_KEY for a real OpenAI key when one is available.
  openaiApiKey: process.env.OPENAI_DIRECT_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
};

if (!env.geminiApiKey) {
  throw new Error('GOOGLE_API_KEY missing — set it in .env.local');
}

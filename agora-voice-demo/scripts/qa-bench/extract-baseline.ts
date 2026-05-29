// Extract the live DEFAULT_PERSONA + planner SYSTEM strings from prod source.
// Run ONCE to seed prompts/baseline.json so the bench tests what's actually
// shipped, not a copy that may have drifted.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..', '..');

function extractBacktickConst(srcPath: string, constName: string): string {
  const src = readFileSync(srcPath, 'utf8');
  // const NAME = `...`  — capture the template literal contents.
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`could not find const ${constName} in ${srcPath}`);
  return m[1];
}

const persona = extractBacktickConst(
  join(repoRoot, 'lib/orchestrator/index.ts'),
  'DEFAULT_PERSONA',
);
const planner_system = extractBacktickConst(
  join(repoRoot, 'lib/orchestrator/resume-planner.ts'),
  'SYSTEM',
);

const out = {
  source_files: [
    'lib/orchestrator/index.ts (DEFAULT_PERSONA)',
    'lib/orchestrator/resume-planner.ts (SYSTEM)',
  ],
  extracted_at: new Date().toISOString(),
  persona,
  planner_system,
};

const outPath = join(repoRoot, 'docs/experiments/2026-05-28-qa-resume-benchmark/prompts/baseline.json');
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('wrote', outPath);
console.log('persona chars:', persona.length);
console.log('planner_system chars:', planner_system.length);

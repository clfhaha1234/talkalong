import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../qa-bench/env';
import { createGeminiCompletion } from '../../lib/orchestrator/gemini-client';
import { runAgenda } from './engine';
import { gradeRun } from './grade';
import { makePersona, type PersonaSpec } from './persona';
import { TranscriptActuator } from './testing';
import type { Agenda } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(k: string): string | undefined { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const agendaName = arg('--agenda') ?? 'hr';
  const personaKind = (arg('--persona') ?? 'cooperative') as PersonaSpec['kind'];
  const out = arg('--out');
  const metaUtterance = arg('--meta-utterance') ?? 'please switch to Japanese';

  const agenda = JSON.parse(readFileSync(join(__dirname, 'agendas', `${agendaName}.json`), 'utf8')) as Agenda;
  const llm = createGeminiCompletion({ apiKey: env.geminiApiKey, model: env.geminiModel, temperature: 0.7, maxTokens: 512 });

  const actuator = new TranscriptActuator();
  const spec: PersonaSpec = personaKind === 'meta' ? { kind: 'meta', metaUtterance } : { kind: personaKind } as PersonaSpec;
  const persona = makePersona(spec, llm, actuator);

  const t0 = Date.now();
  const result = await runAgenda(agenda, actuator, persona, llm, { maxAttempts: 2, maxTurns: 8 });
  const latency_ms = Date.now() - t0;
  const grade = gradeRun(result, agenda);

  const record = { agenda: agendaName, persona: personaKind, latency_ms, grade, result };
  console.log(`[gen-exp] agenda=${agendaName} persona=${personaKind} pass=${grade.pass} coverage=${grade.load_bearing_reached}/${grade.load_bearing_total} graceful=${grade.graceful_ok} forbidden=${grade.forbidden_hits} ${latency_ms}ms`);
  console.log('--- transcript ---');
  for (const e of result.transcript) console.log(`  ${e.role}${e.segment_id ? `[${e.segment_id}]` : ''}: ${e.text}`);
  if (out) { writeFileSync(out, JSON.stringify(record, null, 2)); console.log(`wrote ${out}`); }
}
main().catch((e) => { console.error('[gen-exp] fatal:', e); process.exit(1); });

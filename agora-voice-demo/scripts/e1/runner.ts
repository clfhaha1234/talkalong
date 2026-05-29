// E1 runner — orchestrates baseline + 3 arms across rows × cycles.
//
// Strategy: per arm, start ONE session, run all (rows × cycles) of /say() and
// /interrupt() calls back-to-back, then session.stop() and call getTurns()
// once to fetch all authoritative timings. Match turns to cycles by
// chronological order.
//
// Invocation:
//   pnpm tsx scripts/e1/runner.ts --set train|dev|test --arm <name>
//     [--limit N] [--cycles N] [--interruptAfter ms] [--settle ms]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AgoraClient,
  Area,
  ExpiresIn,
  type AgentSession,
} from 'agora-agent-server-sdk';

import { env } from './lib/env.js';
import { fetchTurnsAfterStop, scoreCycles } from './lib/score.js';
import { runOneCycle, type CycleLocalRecord, type DriveStrategy } from './cycle.js';
import * as baseline from './arms/baseline.js';
import * as arm1 from './arms/arm1_speak.js';
import * as arm2 from './arms/arm2_gemini.js';
import * as arm3 from './arms/arm3_update.js';

type ArmDef = {
  name: string;
  buildAgent: () => ReturnType<typeof baseline.buildAgent>;
  driveStrategy: DriveStrategy;
};

const ARMS: Record<string, ArmDef> = {
  baseline: { name: baseline.NAME, buildAgent: baseline.buildAgent, driveStrategy: baseline.driveStrategy },
  arm1:     { name: arm1.NAME,     buildAgent: arm1.buildAgent,     driveStrategy: arm1.driveStrategy },
  arm2:     { name: arm2.NAME,     buildAgent: arm2.buildAgent,     driveStrategy: arm2.driveStrategy },
  arm3:     { name: arm3.NAME,     buildAgent: arm3.buildAgent,     driveStrategy: arm3.driveStrategy },
};

const REPO_ROOT = join(__dirname, '..', '..');
const EXPERIMENT_DIR = join(
  REPO_ROOT,
  '..',
  'docs',
  'experiments',
  '2026-05-27-e1-agora-narration-control',
);

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = value;
    }
  }
  return out;
}

function loadSet(setName: string): { rows: Array<{ row_id: string; text: string; length?: string; category?: string }> } {
  const path = join(EXPERIMENT_DIR, 'data', `${setName}.json`);
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function ensureDir(filePath: string) {
  const d = dirname(filePath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

async function startSession(arm: ArmDef) {
  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });
  const agent = arm.buildAgent();
  const channel = `e1-${arm.name}-${Date.now()}`;
  const session: AgentSession = agent.createSession(client, {
    channel,
    agentUid: env.agentUid,
    remoteUids: ['*'],
    idleTimeout: 120,
    expiresIn: ExpiresIn.minutes(20),
    debug: false,
  });
  const agentId = await session.start();
  return { session, agentId, channel };
}

async function main() {
  const args = parseArgs();
  const setName = (args.set ?? 'train') as 'train' | 'dev' | 'test';
  const armKey = (args.arm ?? 'arm1') as keyof typeof ARMS;
  const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
  const cycles = args.cycles ? parseInt(args.cycles, 10) : 5;
  const interruptAfterMs = args.interruptAfter ? parseInt(args.interruptAfter, 10) : 1500;
  const postCycleSettleMs = args.settle ? parseInt(args.settle, 10) : 1200;
  // Iteration 1 fix: long sessions die after ~40 api_speak turns with ErrConflict
  // -> TaskNotFound. Default to restarting the session every N rows (cap turn count
  // per session well under the platform ceiling). `--rowsPerSession 0` keeps the
  // legacy "one session for everything" behavior.
  const rowsPerSession = args.rowsPerSession ? parseInt(args.rowsPerSession, 10) : 1;

  const arm = ARMS[armKey];
  if (!arm) {
    console.error(`Unknown arm: ${armKey}. Available: ${Object.keys(ARMS).join(', ')}`);
    process.exit(1);
  }

  const { rows } = loadSet(setName);
  const targetRows = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);

  console.log(`[runner] arm=${armKey} (${arm.name}) set=${setName} rows=${targetRows.length} cycles/row=${cycles} rowsPerSession=${rowsPerSession}`);
  console.log(`[runner] interruptAfter=${interruptAfterMs}ms postCycleSettle=${postCycleSettleMs}ms`);

  const localRecords: CycleLocalRecord[] = [];
  // We'll accumulate turns across multiple sessions and history-aware match per-session.
  const allTurns: Awaited<ReturnType<typeof fetchTurnsAfterStop>> = [];
  let historyAssistantUtterances: string[] = [];

  // Chunk rows into sessions
  const chunkSize = rowsPerSession === 0 ? targetRows.length : rowsPerSession;
  const chunks: Array<typeof targetRows> = [];
  for (let i = 0; i < targetRows.length; i += chunkSize) {
    chunks.push(targetRows.slice(i, i + chunkSize));
  }

  // Per-chunk session: each session collects its own turn list. We append
  // turns with a per-session offset so the global matcher sees them in order.
  // The matcher pairs api_speak turns to cycles in chronological order across
  // ALL turns combined; since each chunk is processed sequentially, this works.

  const totalCycles = targetRows.length * cycles;
  let cycleCount = 0;
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    console.log(`\n[runner] chunk ${chunkIdx + 1}/${chunks.length}: rows ${chunk.map((r) => r.row_id).join(', ')} — starting session ...`);
    const { session, agentId, channel } = await startSession(arm);
    console.log(`[runner] session running id=${agentId} channel=${channel}`);

    const chunkLocalStart = localRecords.length;

    try {
      for (const row of chunk) {
        for (let c = 1; c <= cycles; c++) {
          cycleCount++;
          process.stdout.write(`  [${cycleCount}/${totalCycles}] row=${row.row_id} cycle=${c} ... `);
          const t0 = Date.now();
          const rec = await runOneCycle({
            session,
            arm: arm.name,
            driveStrategy: arm.driveStrategy,
            row,
            cycleIndex: c,
            interruptAfterMs,
            postCycleSettleMs,
          });
          localRecords.push(rec);
          console.log(`done in ${Date.now() - t0}ms (errors=${rec.errors.length})`);
        }
      }

      // Capture history before stop for this chunk
      try {
        const h = await session.getHistory();
        const utterances = (h.contents ?? [])
          .filter((item) => {
            const r = (item as Record<string, unknown>).role as string | undefined;
            return r?.toLowerCase() === 'assistant' || r?.toLowerCase() === 'agent';
          })
          .map((item) => String((item as Record<string, unknown>).content ?? ''));
        historyAssistantUtterances.push(...utterances);
      } catch (err) {
        console.warn(`[runner] getHistory() failed: ${(err as Error).message.split('\n')[0]}`);
      }
    } finally {
      try {
        await session.stop();
      } catch (err) {
        console.warn(`[runner] session.stop() failed: ${(err as Error).message.split('\n')[0]}`);
      }
    }

    // Fetch this chunk's turns
    const chunkTurns = await fetchTurnsAfterStop(session, 12000, 500);
    console.log(`[runner] chunk ${chunkIdx + 1}: ${chunkTurns.length} turns fetched (${cycleCount - chunkLocalStart}+ cycles in this chunk)`);
    allTurns.push(...chunkTurns);
  }

  const turns = allTurns;
  console.log(`\n[runner] total turns across all chunks: ${turns.length}`);

  const scored = scoreCycles({
    cycles: localRecords,
    turns,
    historyAssistantUtterances,
  });

  const outPath = join(EXPERIMENT_DIR, 'data', `results-${setName}-${armKey}.json`);
  ensureDir(outPath);
  writeFileSync(outPath, JSON.stringify(scored, null, 2));

  // Print summary
  const c1Pass = scored.filter((s) => s.scores.c1_pass).length;
  const c2Pass = scored.filter((s) => s.scores.c2_pass).length;
  const c3Pass = scored.filter((s) => s.scores.c3_pass).length;
  const allPass = scored.filter(
    (s) => s.scores.c1_pass && s.scores.c2_pass && s.scores.c3_pass,
  ).length;
  console.log(`\n[runner] SUMMARY (${scored.length} cycles):`);
  console.log(`  C1 (interrupt<300ms):  ${c1Pass}/${scored.length}  ${((c1Pass / scored.length) * 100).toFixed(1)}%`);
  console.log(`  C2 (speak<800ms):      ${c2Pass}/${scored.length}  ${((c2Pass / scored.length) * 100).toFixed(1)}%`);
  console.log(`  C3 (jaccard>=0.9):     ${c3Pass}/${scored.length}  ${((c3Pass / scored.length) * 100).toFixed(1)}%`);
  console.log(`  ALL three pass:        ${allPass}/${scored.length}  ${((allPass / scored.length) * 100).toFixed(1)}%`);

  // Cycle-stability per row (C4)
  const rowMap = new Map<string, ScoredCycleStub[]>();
  type ScoredCycleStub = { c1_pass: boolean; c2_pass: boolean; c3_pass: boolean };
  for (const s of scored) {
    const arr = rowMap.get(s.row_id) ?? [];
    arr.push(s.scores);
    rowMap.set(s.row_id, arr);
  }
  let rowsPassingC4 = 0;
  for (const [rowId, recs] of rowMap) {
    const allTriple = recs.filter((r) => r.c1_pass && r.c2_pass && r.c3_pass).length;
    if (allTriple >= 4) rowsPassingC4++;
    if (recs.length >= cycles)
      console.log(
        `  row ${rowId}: ${allTriple}/${recs.length} cycles all-three-pass  ${allTriple >= 4 ? '✓C4' : '✗C4'}`,
      );
  }
  console.log(`  C4 (>=4/${cycles} cycles all-three-pass per row): ${rowsPassingC4}/${rowMap.size} rows`);

  console.log(`\n[runner] wrote ${scored.length} records to ${outPath}`);
}

main().catch((err) => {
  console.error('[runner] fatal:', err);
  process.exit(1);
});

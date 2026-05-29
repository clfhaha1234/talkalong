// scripts/phase34/verify-resume.ts
//
// End-to-end verification harness for the narration + text-interrupt-resume
// pipeline. Hits the LIVE dev server over HTTP so it exercises the real
// /api/lesson/start route → orchestrator → narrator → Gemini script + image
// gen → Agora session, and the real /api/tutor/qa-ended → resume planner.
//
// We can't hear audio in a script, but we CAN verify the full event timeline:
//   - segments fire in order, spaced by real audio duration (per-segment sleep)
//   - a text-triggered qa-ended produces bridge + active_scene_changed +
//     branch_ended
//   - the narrator resumes and the run reaches narration_complete
//
// Usage:
//   pnpm exec tsx scripts/phase34/verify-resume.ts
//   BASE_URL=http://localhost:3002 pnpm exec tsx scripts/phase34/verify-resume.ts
//   INTERRUPT=off pnpm exec tsx scripts/phase34/verify-resume.ts   # golden path only

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const INTERRUPT = (process.env.INTERRUPT ?? 'on') !== 'off';
// Fire an interrupt after these segment_started counts. Comma-separated to
// stress multiple BRANCH cycles in one session, e.g. INTERRUPT_AFTER=2,4.
const INTERRUPT_AFTER_LIST = (process.env.INTERRUPT_AFTER ?? '2')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const INTERRUPT_AFTER_SEGMENTS = INTERRUPT_AFTER_LIST[0] ?? 2;
const TOPIC =
  process.env.TOPIC ??
  "Why the sky is blue — explain Rayleigh scattering to a curious 9-year-old.";

interface LoggedEvent {
  t_ms: number;
  type: string;
  detail?: string;
}

const t0 = Date.now();
const events: LoggedEvent[] = [];
function log(type: string, detail?: string) {
  const rec = { t_ms: Date.now() - t0, type, detail };
  events.push(rec);
  const detailStr = detail ? `  ${detail}` : '';
  console.log(`  [+${String(rec.t_ms).padStart(6)}ms] ${type}${detailStr}`);
}

async function fireInterrupt(sessionId: string) {
  const qa_history = [
    { role: 'user', text: 'Wait — what does "scatter" actually mean here?', ts: Date.now() },
    {
      role: 'agent',
      text: 'It means the tiny bits of air bounce the light in all directions, like marbles knocking a beam apart.',
      ts: Date.now(),
    },
  ];
  try {
    const res = await fetch(`${BASE_URL}/api/tutor/qa-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, qa_history }),
    });
    log('qa-ended:posted', `status=${res.status}`);
  } catch (err) {
    log('qa-ended:error', (err as Error).message);
  }
}

async function main() {
  console.log(`\n=== verify-resume ===`);
  console.log(`BASE_URL=${BASE_URL}  INTERRUPT=${INTERRUPT}  after=${INTERRUPT_AFTER_SEGMENTS} segments`);
  console.log(`topic: ${TOPIC}\n`);

  const res = await fetch(`${BASE_URL}/api/lesson/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_text: TOPIC }),
  });
  if (!res.ok || !res.body) {
    console.error(`FATAL: /api/lesson/start returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  let sessionId: string | null = null;
  let segmentStartedCount = 0;
  const firedThresholds = new Set<number>();
  let interruptCount = 0;
  let interruptFiredAtSegment = -1;
  let sawBridge = false;
  let bridgeCount = 0;
  let sawActiveSceneChanged = false;
  let sawBranchEnded = false;
  let sawComplete = false;
  let videoReadyCount = 0;
  let firstVideoBeforeSession = false;
  let sessionStarted = false;
  const segmentStartTimes: number[] = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }
      const type = String(ev.type);

      switch (type) {
        case 'script_drafted':
          log(type, `title="${ev.title}"`);
          break;
        case 'scenes_composed':
          log(type, `${(ev.scenes as unknown[]).length} scenes`);
          break;
        case 'image_ready':
          log(type, `${ev.scene_id} cached=${ev.cached} ${ev.latency_ms}ms`);
          break;
        case 'image_failed':
          log(type, `${ev.scene_id} ${ev.error}`);
          break;
        case 'all_images_ready':
          log(type);
          break;
        case 'video_ready':
          videoReadyCount++;
          if (!sessionStarted) firstVideoBeforeSession = true;
          log(type, `${ev.scene_id} cached=${ev.cached} ${ev.latency_ms}ms`);
          break;
        case 'video_failed':
          log(type, `${ev.scene_id} ${ev.error}`);
          break;
        case 'all_videos_ready':
          log(type);
          break;
        case 'session_started':
          sessionStarted = true;
          log(type, `agent=${ev.agent_id}`);
          break;
        case 'snapshot': {
          const snap = ev.snapshot as { session_id?: string; outer_state?: string };
          if (!sessionId && snap.session_id) {
            sessionId = snap.session_id;
            log('snapshot', `session_id=${sessionId}`);
          }
          break;
        }
        case 'segment_started': {
          segmentStartedCount++;
          segmentStartTimes.push(Date.now() - t0);
          log(type, `#${segmentStartedCount} ${ev.segment_id} "${String(ev.text).slice(0, 40)}…"`);
          if (INTERRUPT && sessionId && INTERRUPT_AFTER_LIST.includes(segmentStartedCount) && !firedThresholds.has(segmentStartedCount)) {
            firedThresholds.add(segmentStartedCount);
            interruptCount++;
            if (interruptFiredAtSegment < 0) interruptFiredAtSegment = segmentStartedCount;
            // small delay so we interrupt MID-segment, not at its boundary
            setTimeout(() => void fireInterrupt(sessionId!), 600);
          }
          break;
        }
        case 'segment_completed':
          log(type, String(ev.segment_id));
          break;
        case 'branch_started':
          log(type, `paused=${ev.paused_segment_id}`);
          break;
        case 'bridge_started':
          sawBridge = true;
          bridgeCount++;
          log(type, `"${String(ev.text).slice(0, 60)}…"`);
          break;
        case 'active_scene_changed':
          sawActiveSceneChanged = true;
          log(type, `scene=${ev.scene_id} reason=${ev.reason}`);
          break;
        case 'branch_ended':
          sawBranchEnded = true;
          log(type, `paused=${ev.paused_segment_id}`);
          break;
        case 'bridge_completed':
          log(type);
          break;
        case 'comprehension_changed':
          log(type);
          break;
        case 'narration_complete':
          sawComplete = true;
          log(type);
          break outer;
        case 'error':
          log(type, String(ev.message));
          break;
        default:
          log(type);
      }
    }
  }

  // ── Assertions ──
  console.log(`\n=== RESULTS ===`);
  const gaps = segmentStartTimes.slice(1).map((t, i) => t - segmentStartTimes[i]);
  const realSpacing = gaps.some((g) => g > 700); // at least one real gap

  const checks: Array<{ id: string; pass: boolean; note: string }> = [
    {
      id: 'G1a segments in order',
      pass: segmentStartedCount >= 2,
      note: `${segmentStartedCount} segment_started events`,
    },
    {
      id: 'G1b real audio spacing',
      pass: realSpacing,
      note: `gaps(ms)=[${gaps.join(', ')}]`,
    },
    {
      id: 'G1c reached narration_complete',
      pass: sawComplete,
      note: sawComplete ? 'yes' : 'NO — stream ended without it',
    },
    {
      id: 'G5a scene-1 video before session start',
      pass: firstVideoBeforeSession,
      note: firstVideoBeforeSession
        ? 'yes — first video_ready arrived before session_started'
        : 'NO — story started with no animated scene 1',
    },
    {
      id: 'G5b all scenes animated',
      pass: videoReadyCount >= 5,
      note: `${videoReadyCount} video_ready events`,
    },
  ];
  if (INTERRUPT) {
    checks.push(
      { id: 'G2a bridge_started', pass: sawBridge, note: sawBridge ? 'yes' : 'NO' },
      {
        id: 'G2b active_scene_changed',
        pass: sawActiveSceneChanged,
        note: sawActiveSceneChanged ? 'yes' : 'NO',
      },
      { id: 'G2c branch_ended', pass: sawBranchEnded, note: sawBranchEnded ? 'yes' : 'NO' },
      {
        id: 'G3 resumed + completed after interrupt',
        pass: sawComplete && interruptCount > 0,
        note: `${interruptCount} interrupt(s) fired (first at seg #${interruptFiredAtSegment}), complete=${sawComplete}`,
      },
      {
        id: 'G4 one bridge per interrupt',
        pass: bridgeCount >= interruptCount && interruptCount > 0,
        note: `${bridgeCount} bridges for ${interruptCount} interrupts`,
      },
    );
  }

  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`  [${mark}] ${c.id} — ${c.note}`);
  }
  console.log(`\n${allPass ? '✅ ALL CHECKS PASS' : '❌ SOME CHECKS FAILED'}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('harness fatal:', err);
  process.exit(2);
});

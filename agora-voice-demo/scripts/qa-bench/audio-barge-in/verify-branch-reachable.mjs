// ACCEPTANCE GATE for the barge-in coordination root bug (2026-06-01).
//
// The orchestrator keeps each live session in an in-memory, module-global
// registry (lib/orchestrator/session-registry.ts, stashed on globalThis). That
// is fine in ONE process (local `next dev`, or `next start` on a persistent
// host): /api/lesson/start, /api/tutor/branch-started and /api/tutor/qa-ended
// all share the same globalThis → get(session_id) finds the session.
//
// On Vercel, EACH App-Router route is a SEPARATE serverless function with its
// OWN globalThis. So the session registered by /api/lesson/start is invisible
// to /api/tutor/branch-started and /qa-ended → they return 404 "session not
// found" → the narrator is never paused and the resume planner never runs →
// the agent "ignores" the listener ("无视我的话"). Narration still works (it's
// self-contained inside the SSE function), which is why this hid for so long.
//
// This test makes the failure impossible to miss + impossible to falsely call
// "fixed": start a REAL session, then fire the two coordination POSTs at it and
// assert they reach it (HTTP 202, not 404).
//
//   node scripts/qa-bench/audio-barge-in/verify-branch-reachable.mjs               # local (default 3000)
//   BARGE_BASE_URL=https://agora-voice-demo.vercel.app node …/verify-branch-reachable.mjs   # prod

const BASE = process.env.BARGE_BASE_URL || 'http://localhost:3000';
const TOPIC = process.env.TOPIC || 'Tell a short 3-scene bedtime story about a library cat named Pemberley.';
const SESSION_WAIT_MS = Number(process.env.SESSION_WAIT_MS || 150000);

// Start the SSE and resolve the session_id from the first `snapshot` event.
// Keeps the response body reader open (the session stays alive) until we abort.
async function startSessionAndGetId() {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/lesson/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_text: TOPIC }),
    signal: ac.signal,
  });
  if (!res.ok || !res.body) throw new Error(`lesson/start HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/"session_id":"([^"]+)"/);
    if (m) return { sessionId: m[1], abort: () => ac.abort(), reader };
    // surface a hard SSE error early
    if (/"type":"error"/.test(buf)) {
      const em = buf.match(/"type":"error"[^}]*"message":"([^"]+)"/);
      throw new Error(`SSE error before session_id: ${em?.[1] ?? 'unknown'}`);
    }
  }
  ac.abort();
  throw new Error('no session_id within timeout');
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text.slice(0, 200) };
}

async function main() {
  console.log(`▶ branch-reachable acceptance · ${BASE}`);
  let sess;
  try {
    sess = await startSessionAndGetId();
  } catch (e) {
    console.log(`❌ could not start a session: ${e.message}`);
    process.exit(2);
  }
  const { sessionId, abort } = sess;
  console.log(`  live session_id = ${sessionId}`);

  // Fire the two cross-function coordination POSTs at the LIVE session.
  const branch = await post('/api/tutor/branch-started', { session_id: sessionId, branch_id: 1 });
  const qa = await post('/api/tutor/qa-ended', { session_id: sessionId, qa_history: [{ role: 'user', text: 'what is light?', ts: 1 }], branch_id: 1 });
  abort();

  console.log(`  /branch-started → HTTP ${branch.status}  ${branch.body}`);
  console.log(`  /qa-ended      → HTTP ${qa.status}  ${qa.body}`);

  const pass = branch.status === 202 && qa.status === 202;
  console.log('\n=== BARGE-IN COORDINATION REACHABILITY ===');
  if (pass) {
    console.log('  ✅ PASS — both coordination POSTs reached the live session (same-process registry).');
  } else {
    console.log('  ❌ FAIL — a coordination POST did NOT reach the session.');
    if (branch.status === 404 || qa.status === 404) {
      console.log('     404 "session not found" = the cross-function in-memory registry split:');
      console.log('     /api/lesson/start holds the session in one function; the POST hit another.');
      console.log('     => voice barge-in / QA resume is structurally broken in this environment.');
      console.log('     Fix: run on a persistent single-process host (next start), OR bridge the');
      console.log('     signal through a durable store the orchestrator polls (handle can\'t serialize).');
    }
  }
  process.exit(pass ? 0 : 1);
}

main();

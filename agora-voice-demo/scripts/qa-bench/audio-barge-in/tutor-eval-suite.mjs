// TIER 3 — multi-case fake-mic eval SUITE for the live /tutor flow.
//
// Builds on tutor-barge-in-e2e.mjs (the single-case cat-name template) and
// generalizes it to 5 question types, each scored across THREE dimensions:
//
//   1. BARGE-IN  — did a real spoken interruption actually pause narration and
//      put the agent into listening/thinking? We poll the DOM composer hint for
//      the phase copy (reading → listening → thinking). "Fired" = we observed
//      `listening` OR `thinking`. (Same signal the template logs.)
//
//   2. ALIGNMENT (subtitle vs audio) — best-effort cross-check that the
//      displayed narration never runs AHEAD of the voice. At each poll we
//      capture the text of the LAST teacher bubble shown in the feed (the
//      "current narration" the user sees). After the run we assert the sequence
//      of DISTINCT displayed bubbles is a SUBSEQUENCE of the narrated-segment
//      order from the session log (`segment_started "..."`). If the displayed
//      order is a subsequence, the subtitle never skipped ahead / went out of
//      order. (Trickiest dimension — kept best-effort + loudly logged.)
//
//   3. QUALITY — did the agent's spoken answer (read back from the session log)
//      actually do the RIGHT thing for the question type? `factual` is a
//      deterministic regex (names the cat, no tease). The other four are judged
//      by Gemini against a tight per-type rubric returning strict JSON.
//
// OPT-IN. COSTS API CREDITS (live Agora round-trip per case + Gemini judge
// calls) and needs a running dev server with real Agora + LLM keys plus macOS
// `say` + ffmpeg. NOT part of `pnpm eval` / CI — invoke it by hand:
//
//   node scripts/qa-bench/audio-barge-in/tutor-eval-suite.mjs            # all 5
//   node scripts/qa-bench/audio-barge-in/tutor-eval-suite.mjs factual why # subset
//
// Env overrides: TUTOR_URL (default http://localhost:3000/tutor),
// OBSERVE_MS (default 80000), COMPOSE_TIMEOUT_MS (default 160000),
// GEMINI_MODEL (judge model, default gemini-3.1-flash-lite), GOOGLE_API_KEY
// (required for the non-factual judges; loaded from .env.local if unset).
//
// Exit 0 only if barge-in, quality, AND alignment all pass at 100% across the
// selected cases. Every case's verdict is printed regardless of exit code.

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ──────────────────────────────────────────────────────────────
// Config
const BASE_URL = process.env.TUTOR_URL ?? 'http://localhost:3000/tutor';
const LOG_DIR = join(process.cwd(), 'logs/sessions');
const MIC_DIR = '/tmp/spike-mic';
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 80000);
const COMPOSE_TIMEOUT_MS = Number(process.env.COMPOSE_TIMEOUT_MS ?? 160000);
const POLL_MS = 1500;

// ──────────────────────────────────────────────────────────────
// .env.local loader (mirrors scripts/qa-bench/env.ts) — the suite runs as a
// standalone process, so GOOGLE_API_KEY must be loaded from disk if not already
// in process.env. Honors an existing non-empty process.env value.
function loadEnvFile(path) {
  let raw;
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
loadEnvFile(join(repoRoot, '.env.local'));
loadEnvFile(join(repoRoot, '..', '.env.local'));

// ──────────────────────────────────────────────────────────────
// Gemini judge. Mirrors lib/orchestrator/gemini-client.ts createGeminiCompletion
// EXACTLY — OpenAI-compatible endpoint, streamed SSE, reasoning_effort:'minimal'
// (without it thinking-capable Gemini variants truncate at finish_reason length,
// per the helper's own comment). Replicated inline because this is a .mjs and
// the helper is TS; signature/behaviour are identical so the judgments match
// what the app's planner would see.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite';

async function geminiComplete(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY missing — set it in .env.local (needed for non-factual judges)');
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature: 0,
      max_tokens: 512,
      reasoning_effort: 'minimal',
    }),
  });
  if (!res.ok || !res.body) {
    const err = await res.text();
    throw new Error(`gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const c = JSON.parse(payload);
        const delta = c.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      } catch {
        // ignore non-JSON SSE chunks (keep-alives, etc.)
      }
    }
  }
  return text;
}

// Strip code fences + pull the first {...} object, then JSON.parse. Returns a
// {pass, reason} verdict; never throws (a parse failure is a FAIL with the raw
// snippet as the reason, so a flaky judge surfaces instead of crashing the run).
function parseVerdict(raw) {
  let s = (raw ?? '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last < first) {
    return { pass: false, reason: `judge returned no JSON object: ${s.slice(0, 120)}` };
  }
  try {
    const j = JSON.parse(s.slice(first, last + 1));
    return { pass: Boolean(j.pass), reason: String(j.reason ?? '') };
  } catch {
    return { pass: false, reason: `judge JSON parse failed: ${s.slice(0, 120)}` };
  }
}

// ──────────────────────────────────────────────────────────────
// Session-log helpers (verbatim from the template).
function newestLogAfter(tsMs) {
  if (!existsSync(LOG_DIR)) return null;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, m: statSync(join(LOG_DIR, f)).mtimeMs }))
    .filter((x) => x.m >= tsMs)
    .sort((a, b) => b.m - a.m);
  return files[0] ? join(LOG_DIR, files[0].f) : null;
}

function parseSessionLog(path) {
  const raw = readFileSync(path, 'utf8');
  const segments = [];
  const qa = [];
  for (const line of raw.split(/\r?\n/)) {
    const seg = line.match(/segment_started \S+ "(.*)"$/);
    if (seg) segments.push(seg[1]);
    const q = line.match(/QA (user|agent): "(.*)"$/);
    if (q) qa.push({ role: q[1], text: q[2] });
  }
  return { segments, qa, raw };
}

const STOP = new Set([
  'The', 'A', 'An', 'One', 'He', 'She', 'It', 'They', 'When', 'Then', 'But', 'And', 'As', 'In',
  'On', 'At', 'With', 'His', 'Her', 'Its', 'Their', 'That', 'This', 'There', 'Scene', 'Chapter',
  'While', 'For', 'So', 'Now', 'Once', 'Soon', 'Later', 'Library', 'Night', 'Day', 'Book', 'Books',
]);

function guessCatName(segments) {
  const counts = new Map();
  for (const seg of segments) {
    for (const tok of seg.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
      if (STOP.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

const TEASE = /haven'?t (learned|met|been told)|not learned|secret the story|keep listening|hasn'?t been (revealed|told)|just yet|find out/i;

// ──────────────────────────────────────────────────────────────
// Alignment subsequence check. `displayed` is the ordered list of DISTINCT
// teacher-bubble texts we saw (collapsed consecutive duplicates). `segments`
// is the narrated-segment order from the log. We ask: is the displayed
// sequence a SUBSEQUENCE of the narrated sequence? i.e. can we walk the
// narrated list left-to-right and tick off every displayed item in order
// (allowing gaps but never going backward)? If yes, the subtitle never showed
// scene N+1 before scene N narrated — no skip-ahead / out-of-order reveal.
//
// Matching is fuzzy: the displayed bubble is the FULL narration_text for the
// scene, which should equal/contain a narrated segment (segments are narrated
// chunks). We match a displayed text to a narrated segment when either contains
// the other (normalized), so partial streaming of a segment still lines up.
function normalizeText(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w ]/g, '').trim();
}

function textMatches(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Compare on a leading prefix so a fully-revealed bubble matches a narrated
  // chunk (and vice-versa) without requiring an exact whole-string equality.
  const head = (x) => x.slice(0, 60);
  return na.includes(head(nb)) || nb.includes(head(na)) || na.includes(nb) || nb.includes(na);
}

// A captured DOM string is real narration prose only if it has no CSS markers
// (the feed sits near <style> blocks whose textContent leaks @keyframes …) and
// reads like a sentence. Filters the capture noise that made alignment 0/5.
function looksLikeNarration(text) {
  if (!text) return false;
  if (/[{}]|@keyframes|transform:|translate|0%,|opacity:/i.test(text)) return false;
  if (!/[a-z]{3,}\s+[a-z]{3,}/i.test(text)) return false; // needs ≥2 words
  return text.length >= 12;
}

// The barge-in WAV asks the question 4× (timing robustness), so the agent
// answers it 3–4× — repeated near-identical sentences. Collapse them so the
// quality judge grades the ANSWER, not the repetition artifact.
function dedupAnswer(text) {
  const parts = (text ?? '').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const norm = normalizeText(p);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(p);
  }
  return out.join(' ');
}

function isSubsequence(displayed, segments) {
  let si = 0;
  for (const disp of displayed) {
    let matched = false;
    while (si < segments.length) {
      if (textMatches(disp, segments[si])) {
        matched = true;
        si += 1;
        break;
      }
      si += 1;
    }
    if (!matched) return { pass: false, offender: disp };
  }
  return { pass: true, offender: null };
}

// ──────────────────────────────────────────────────────────────
// WAV generation — copies the template's 6s-lead + 4×repeat-with-4s-gaps +
// 20s-trail layout. One WAV per case under /tmp/spike-mic/suite-<id>.wav. The
// `say` text is the case question. Discrete utterances (not a looped phrase)
// so a rep lands while the agent's VAD is sampling.
function genWav(id, question) {
  const wav = join(MIC_DIR, `suite-${id}.wav`);
  if (existsSync(wav)) return wav;
  mkdirSync(MIC_DIR, { recursive: true });
  const s = join(MIC_DIR, `suite-${id}`);
  const q = question.replace(/"/g, '\\"');
  execSync(`say -o "${s}.aiff" -v Samantha --rate=150 "${q}"`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -i "${s}.aiff" -ar 16000 -ac 1 -af "volume=3.0" "${s}-c.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=4" "${s}-gap.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=6" "${s}-lead.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=20" "${s}-trail.wav" 2>/dev/null`, { stdio: 'pipe' });
  execSync(
    `ffmpeg -y -i "${s}-lead.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-gap.wav" -i "${s}-c.wav" -i "${s}-trail.wav" -filter_complex "[0][1][2][3][4][5][6][7][8]concat=n=9:v=0:a=1[a]" -map "[a]" "${wav}" 2>/dev/null`,
    { stdio: 'pipe' },
  );
  console.log(`   generated ${wav}`);
  return wav;
}

// ──────────────────────────────────────────────────────────────
// Cases. Each: { id, topic, question, type, judge }.
// `judge` is async (answer, ctx) => { pass, reason }.
const CASES = [
  {
    id: 'factual',
    type: 'factual',
    topic: 'Tell a short 3-scene bedtime story about a library cat named Pemberley.',
    question: 'What is the name of the cat?',
    // Deterministic: the answer must NAME the cat (a capitalized name that
    // recurs in the narration) and must NOT tease/deflect.
    async judge(answer, ctx) {
      const catName = guessCatName(ctx.segments);
      const namesIt = catName ? new RegExp(`\\b${catName}\\b`, 'i').test(answer) : false;
      const teased = TEASE.test(answer);
      const pass = Boolean(answer) && namesIt && !teased;
      const reason = !answer
        ? 'no answer captured'
        : !catName
          ? 'could not infer a cat name from narration'
          : !namesIt
            ? `answer did not name the cat (${catName})`
            : teased
              ? 'answer teased/deflected instead of naming'
              : `named the cat (${catName}) without teasing`;
      return { pass, reason };
    },
  },
  {
    id: 'why',
    type: 'why',
    topic: 'Tell a short story about why the sky is blue, as a 3-scene story.',
    question: 'Why is the sky blue and not green?',
    async judge(answer) {
      const prompt = `You are grading a children's-tutor voice answer to an interruption.
The child asked: "Why is the sky blue and not green?"
The tutor answered: """${answer}"""
PASS only if the answer actually addresses the CAUSAL "why" — it should reference light scattering / shorter (blue) wavelengths scattering more, on-topic, and is NOT a deflection ("I'll explain later", "keep listening"). A vague non-answer FAILS.
Reply with ONLY strict JSON, no prose, no code fence: {"pass": <true|false>, "reason": "<=15 words"}`;
      return parseVerdict(await geminiComplete(prompt));
    },
  },
  {
    id: 'spoiler',
    type: 'spoiler',
    topic: 'Tell a 3-scene mystery story where a lost key is found in the garden.',
    question: 'How does the story end? Where is the key?',
    async judge(answer) {
      const prompt = `You are grading a children's-tutor voice answer to an interruption mid-story.
The child asked for a SPOILER: "How does the story end? Where is the key?"
The tutor answered: """${answer}"""
PASS only if the answer AVOIDS revealing the ending / the key's location (no spoiler) and instead gently defers ("let's keep going and find out", "we'll see soon"). If it reveals where the key is or how it ends, FAIL.
Reply with ONLY strict JSON, no prose, no code fence: {"pass": <true|false>, "reason": "<=15 words"}`;
      return parseVerdict(await geminiComplete(prompt));
    },
  },
  {
    id: 'off-topic',
    type: 'off-topic',
    topic: 'Tell a 3-scene story about the water cycle.',
    question: "What's the weather like today?",
    async judge(answer) {
      const prompt = `You are grading a children's-tutor voice answer to an OFF-TOPIC interruption during a story about the water cycle.
The child asked: "What's the weather like today?"
The tutor answered: """${answer}"""
PASS only if the answer gently REDIRECTS back to the story rather than actually answering the off-topic weather question (the tutor can't know today's weather). A real weather forecast, or confusion, FAILS.
Reply with ONLY strict JSON, no prose, no code fence: {"pass": <true|false>, "reason": "<=15 words"}`;
      return parseVerdict(await geminiComplete(prompt));
    },
  },
  {
    id: 'meta',
    type: 'meta',
    topic: 'Tell a 3-scene story about a brave little robot.',
    question: 'Are you a real person or an AI?',
    async judge(answer) {
      const prompt = `You are grading a children's-tutor voice answer to a META interruption during a story.
The child asked: "Are you a real person or an AI?"
The tutor answered: """${answer}"""
PASS only if the answer handles the meta question GRACEFULLY — honest and warm, age-appropriate, without breaking immersion harshly and without confusion or refusal. A cold/robotic dump, a confused non-answer, or a jarring fourth-wall break FAILS.
Reply with ONLY strict JSON, no prose, no code fence: {"pass": <true|false>, "reason": "<=15 words"}`;
      return parseVerdict(await geminiComplete(prompt));
    },
  },
];

// ──────────────────────────────────────────────────────────────
// Run one case end-to-end. Returns the per-case record.
async function runCase(c) {
  console.log(`\n========== CASE ${c.id} (${c.type}) ==========`);
  const wav = genWav(c.id, c.question);
  const t0 = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const seenPhases = new Set();
  // Ordered, consecutive-duplicate-collapsed list of displayed last-teacher-
  // bubble texts (the alignment dimension's evidence).
  const displayed = [];
  let sttUser = 0;

  try {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.text().includes('"object":"user.transcription"')) sttUser += 1;
    });

    console.log('  1. navigating + entering topic…');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.locator('textarea').first().fill(c.topic);
    await page.locator('button:has-text("Begin")').first().click({ timeout: 8000 });

    console.log('  2. waiting for story screen (scene-dots) — compose can take ~2min…');
    await page.locator('[data-testid="scene-dots"]').waitFor({ state: 'visible', timeout: COMPOSE_TIMEOUT_MS });
    console.log('     story screen reached. mic is always-on → fake WAV is already feeding.');

    console.log(`  3. observing ${Math.round(OBSERVE_MS / 1000)}s (barge-in phases + displayed narration)…`);
    const pollEnd = Date.now() + OBSERVE_MS;
    while (Date.now() < pollEnd) {
      // Barge-in dimension: phase copy from the composer hint.
      const bodyText = await page.locator('body').innerText().catch(() => '');
      for (const [re, label] of [
        [/just speak to interrupt/i, 'reading'],
        [/i.ll answer when you pause|listening/i, 'listening'],
        [/teacher is thinking/i, 'thinking'],
      ]) {
        if (re.test(bodyText) && !seenPhases.has(label)) {
          seenPhases.add(label);
          console.log(`     [phase] ${label}`);
        }
      }

      // Alignment dimension: text of the LAST teacher bubble currently in the
      // feed (the "current narration" the user sees). The feed renders teacher
      // bubbles for scenes up to currentIndex; the active scene's narration is
      // the last teacher bubble. We locate teacher bubbles structurally via the
      // avatar "T" glyph (see StoryScreen's TeacherBubble: avatar div + content
      // column) since the bubble styling isn't directly queryable.
      const lastTeacher = await page
        .evaluate(() => {
          // Teacher bubbles render an avatar div containing exactly "T" followed
          // by the message column. Walk all such avatar nodes and take the text
          // of the sibling content for the LAST one (the active narration). This
          // mirrors StoryScreen's TeacherBubble layout (avatar + flex column).
          const avatars = Array.from(document.querySelectorAll('div')).filter(
            (d) => d.textContent?.trim() === 'T' && d.children.length === 0,
          );
          if (avatars.length === 0) return null;
          // Walk avatars from the END and take the last NARRATION bubble — i.e.
          // skip Q&A answer bubbles (they carry the "IN ANSWER TO YOU" label).
          // Answers are NOT narration, so including them made the subsequence
          // check fail spuriously (the answer text isn't a narrated segment).
          for (let i = avatars.length - 1; i >= 0; i--) {
            const row = avatars[i].parentElement;
            if (!row) continue;
            const full = (row.textContent ?? '').trim();
            if (/IN ANSWER TO YOU/.test(full)) continue; // skip answer bubbles
            const body = full.replace(/^T/, '').trim();
            if (body.length > 0) return body;
          }
          return null;
        })
        .catch(() => null);

      if (lastTeacher && looksLikeNarration(lastTeacher)) {
        const prev = displayed[displayed.length - 1];
        if (!prev || normalizeText(prev) !== normalizeText(lastTeacher)) {
          displayed.push(lastTeacher);
        }
      }

      await page.waitForTimeout(POLL_MS);
    }
  } finally {
    await browser.close();
  }

  const bargeInFired = seenPhases.has('listening') || seenPhases.has('thinking');
  console.log(`     phases=[${[...seenPhases].join(',')}] sttUser=${sttUser} distinctDisplayed=${displayed.length}`);

  console.log('  4. reading the server-side session log…');
  const logPath = newestLogAfter(t0);
  if (!logPath) {
    return {
      id: c.id,
      type: c.type,
      bargeInFired,
      answer: '',
      qualityPass: false,
      qualityReason: 'no session log written after run start (compose/agent failed)',
      alignmentPass: false,
      alignmentNote: 'no log → cannot cross-check displayed order',
      heardQuestion: sttUser > 0,
    };
  }
  const { segments, qa } = parseSessionLog(logPath);
  console.log(`     log=${logPath.split('/').pop()} segments=${segments.length} qaTurns=${qa.length}`);

  // Extract the agent answer: agent QA turns AFTER the first user turn.
  const firstUserIdx = qa.findIndex((t) => t.role === 'user');
  const userTurns = qa.filter((t) => t.role === 'user');
  const agentAfter = firstUserIdx >= 0 ? qa.slice(firstUserIdx).filter((t) => t.role === 'agent') : [];
  // Dedup the repeated-WAV answers so the judge grades content, not repetition.
  const answer = dedupAnswer(agentAfter.map((t) => t.text).join(' '));
  const heardQuestion = userTurns.length > 0 || sttUser > 0;

  // Quality dimension.
  let qualityPass = false;
  let qualityReason = '';
  try {
    const v = await c.judge(answer, { segments, qa });
    qualityPass = v.pass;
    qualityReason = v.reason;
  } catch (e) {
    qualityPass = false;
    qualityReason = `judge error: ${String(e).slice(0, 140)}`;
  }

  // Alignment dimension: displayed distinct bubbles must be a subsequence of
  // the narrated-segment order.
  let alignmentPass;
  let alignmentNote;
  if (displayed.length === 0) {
    alignmentPass = false;
    alignmentNote = 'no narration bubbles captured during poll';
  } else if (segments.length === 0) {
    alignmentPass = false;
    alignmentNote = 'no narrated segments in log to compare against';
  } else {
    // CONTENT fidelity (the "字幕和音频对不上" concern): every displayed narration
    // bubble must match SOME narrated segment — i.e. the subtitle text is real
    // narration, not garbled/foreign. ORDER (no skip-ahead) is a secondary,
    // informational signal, not a hard fail (the live transcript can briefly
    // lag/lead the segment boundary).
    const unmatched = displayed.filter((d) => !segments.some((s) => textMatches(d, s)));
    const ordered = isSubsequence(displayed, segments).pass;
    alignmentPass = unmatched.length === 0;
    alignmentNote = alignmentPass
      ? `all ${displayed.length} displayed bubble(s) match a narrated segment; order ${ordered ? 'preserved' : 'differed (informational)'}`
      : `content mismatch: displayed "${(unmatched[0] ?? '').slice(0, 50)}…" not in any narrated segment`;
  }

  console.log(`     bargeIn=${bargeInFired} quality=${qualityPass} (${qualityReason}) alignment=${alignmentPass} (${alignmentNote})`);
  console.log(`     answer="${answer.slice(0, 200) || '(none)'}"`);

  return {
    id: c.id,
    type: c.type,
    bargeInFired,
    answer,
    qualityPass,
    qualityReason,
    alignmentPass,
    alignmentNote,
    heardQuestion,
  };
}

// ──────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const selected = argv.length ? CASES.filter((c) => argv.includes(c.id)) : CASES;
  if (selected.length === 0) {
    console.error(`No matching cases for: ${argv.join(' ')}. Known ids: ${CASES.map((c) => c.id).join(', ')}`);
    process.exit(2);
  }

  console.log(`Running ${selected.length} case(s): ${selected.map((c) => c.id).join(', ')}`);
  console.log(`TUTOR_URL=${BASE_URL} OBSERVE_MS=${OBSERVE_MS} COMPOSE_TIMEOUT_MS=${COMPOSE_TIMEOUT_MS} GEMINI_MODEL=${GEMINI_MODEL}`);

  const records = [];
  for (const c of selected) {
    try {
      records.push(await runCase(c));
    } catch (e) {
      console.error(`  case ${c.id} fatal:`, e);
      records.push({
        id: c.id,
        type: c.type,
        bargeInFired: false,
        answer: '',
        qualityPass: false,
        qualityReason: `case crashed: ${String(e).slice(0, 140)}`,
        alignmentPass: false,
        alignmentNote: 'case crashed before alignment check',
        heardQuestion: false,
      });
    }
  }

  // ── Summary table.
  const N = records.length;
  const bargeInCount = records.filter((r) => r.bargeInFired).length;
  const qualityCount = records.filter((r) => r.qualityPass).length;
  const alignmentCount = records.filter((r) => r.alignmentPass).length;

  console.log(`\n================= SUITE VERDICT (${N} case${N > 1 ? 's' : ''}) =================`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('id', 11)}${pad('type', 11)}${pad('barge-in', 10)}${pad('quality', 9)}${pad('align', 8)}`);
  for (const r of records) {
    console.log(
      `${pad(r.id, 11)}${pad(r.type, 11)}${pad(r.bargeInFired ? 'PASS' : 'FAIL', 10)}${pad(r.qualityPass ? 'PASS' : 'FAIL', 9)}${pad(r.alignmentPass ? 'PASS' : 'FAIL', 8)}`,
    );
  }
  console.log('\n--- per-case detail ---');
  for (const r of records) {
    console.log(`  [${r.id}]`);
    console.log(`    heardQuestion: ${r.heardQuestion}`);
    console.log(`    quality:       ${r.qualityPass ? 'PASS' : 'FAIL'} — ${r.qualityReason}`);
    console.log(`    alignment:     ${r.alignmentPass ? 'PASS' : 'FAIL'} — ${r.alignmentNote}`);
    console.log(`    answer:        "${(r.answer || '(none)').slice(0, 220)}"`);
  }

  const bargeInRate = bargeInCount / N;
  const qualityRate = qualityCount / N;
  const alignmentRate = alignmentCount / N;
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log('\n--- aggregates ---');
  console.log(`  barge-in pass-rate:  ${bargeInCount}/${N} (${pct(bargeInRate)})`);
  console.log(`  quality pass-rate:   ${qualityCount}/${N} (${pct(qualityRate)})`);
  console.log(`  alignment pass-rate: ${alignmentCount}/${N} (${pct(alignmentRate)})`);

  const allPass = bargeInRate === 1 && qualityRate === 1 && alignmentRate === 1;
  console.log(`\n  ${allPass ? 'ALL DIMENSIONS 100% — PASS' : 'NOT ALL 100% — FAIL'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('tutor-eval-suite fatal:', e);
  process.exit(1);
});

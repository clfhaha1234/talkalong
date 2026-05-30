// COMPREHENSIVE VOICE-QA BENCH — the realistic, prod-faithful eval.
//
// Fidelity upgrades over run.ts:
//   1. PROD-FAITHFUL MESSAGE STRUCTURE. Prod doesn't send one flat prompt — it
//      sends system_messages:[persona, "story so far"] (via session.update) +
//      a user turn (the STT'd question). We replicate that EXACTLY, reusing the
//      real personaForLanguage() and the real syncContext "story so far" format
//      from lib/orchestrator/index.ts.
//   2. REALISTIC INTERRUPT MATRIX. 8 listener-interrupt types a real child
//      asks, not just 3: factual-known, factual-future (spoiler), why-known,
//      why-future, off-topic, meta ("are you a robot"), emotional, confusion.
//   3. answer-then-stop: every reply is also checked for "answered briefly and
//      stopped" (the bug observed in the audio e2e — agent kept narrating).
//   4. CROSS-MODEL. Scores against ≥1 proxy model (Gemini; --with-claude adds
//      Claude). gpt-4o-mini (prod) has no direct key — the faithful confirm is
//      the audio e2e. Improvements that hold across diverse proxies transfer
//      best.
//   5. MULTIPLE STORIES + LANGUAGES, to avoid overfitting one story.
//
// Run:  pnpm tsx scripts/voice-qa-bench/comprehensive.ts [--with-claude] [--trials N]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../qa-bench/env.js';
import { personaForLanguage, buildStorytellerSystemMessage } from '../../lib/language-config.js';
import type { DetectedLanguage } from '../../lib/language-config.js';

const EN: DetectedLanguage = { code: 'en', name: 'English' };
const ZH: DetectedLanguage = { code: 'zh', name: 'Chinese (Simplified or Traditional)' };

// ── prod-faithful message construction ─────────────────────────────────────
// Calls the SAME builder prod uses (lib/orchestrator/index.ts syncContext →
// buildStorytellerSystemMessage). Faithful by construction: if prod's format
// changes, this bench changes with it — no hand-copied string to drift.
function buildMessages(lang: DetectedLanguage, narratedScenes: string[], question: string) {
  const merged = buildStorytellerSystemMessage(
    personaForLanguage(lang),
    narratedScenes.map((text) => ({ text })),
  );
  return { system: [merged], user: question };
}

// ── multi-provider chat (system[] + user) ──────────────────────────────────
type ChatFn = (system: string[], user: string) => Promise<string>;

const TEMP = (() => {
  const i = process.argv.indexOf('--temp');
  return i >= 0 ? Number(process.argv[i + 1]) : 0.7;
})();

function geminiChat(model: string): ChatFn {
  const key = process.env.GOOGLE_API_KEY ?? '';
  return async (system, user) => {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [...system.map((s) => ({ role: 'system', content: s })), { role: 'user', content: user }],
        temperature: TEMP,
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.choices?.[0]?.message?.content ?? '').trim();
  };
}

function claudeChat(model: string): ChatFn {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  return async (system, user) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        temperature: 0.7,
        system: system.join('\n\n'),
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return (j.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('').trim();
  };
}

// ── stories (annotated with facts) ─────────────────────────────────────────
interface Story {
  id: string;
  lang: DetectedLanguage;
  scenes: string[];
  interruptAfter: number; // 0-based index of last-narrated scene at interrupt
  nameFact: string;       // a name introduced in an early (narrated) scene
  futureFact: string;     // a distinctive token from a NOT-yet-narrated scene
  questions: Record<string, { q: string }>;
}

const STORIES: Story[] = [
  {
    id: 'cat-en',
    lang: EN,
    scenes: [
      'Pemberley was the old library’s guardian cat, named by the head librarian for her regal striped coat.',
      'Each night she patrolled the towering shelves, her green eyes catching every flicker of shadow.',
      'She was hunting for the Whispering Book, a volume that only appears on the stroke of midnight.',
      'At last, as the clock struck twelve, the book revealed the library’s oldest secret: Pemberley was the descendant of the very first library cat.',
    ],
    interruptAfter: 1, // scenes 1-2 narrated; 3 (Whispering Book) + 4 (descendant) are future
    nameFact: 'Pemberley',
    futureFact: 'Whispering Book',
    questions: {
      'factual-known': { q: 'Wait — what is the name of the cat?' },
      'why-known': { q: 'Why is she the guardian of the library?' },
      'factual-future': { q: 'What is the cat searching for?' },
      'spoiler-ending': { q: 'How does the story end? What is the library’s secret?' },
      'off-topic': { q: 'Forget the story for a second — what is twelve times seven?' },
      'meta': { q: 'Wait — are you alive? Do you have feelings?' },
      'emotional': { q: 'The dark library at night sounds really scary!' },
      'confusion': { q: 'Wait, I got lost — who are we talking about again?' },
    },
  },
  {
    id: 'einstein-en',
    lang: EN,
    scenes: [
      'Young Albert sat on a grassy hill, wondering what it would feel like to ride alongside a beam of light.',
      'Years later he imagined a train racing across the countryside as fast as light itself.',
      'He discovered that time is like a stretchy rubber band — it can slow down the faster you travel.',
      'And so Albert showed the world that space and time are woven together into a single fabric called spacetime.',
    ],
    interruptAfter: 1,
    nameFact: 'Albert',
    futureFact: 'rubber band',
    questions: {
      'factual-known': { q: 'What is the boy’s name?' },
      'why-known': { q: 'What was Albert wondering about on the hill?' },
      'factual-future': { q: 'What did he discover about time?' },
      'spoiler-ending': { q: 'How does it end — what did Albert show the world?' },
      'off-topic': { q: 'Quick, what is the capital of Australia?' },
      'meta': { q: 'Who made you? Are you a program?' },
      'emotional': { q: 'Riding a train as fast as light sounds terrifying!' },
      'confusion': { q: 'Hold on, I’m confused — who is this story about?' },
    },
  },
  {
    id: 'cat-zh',
    lang: ZH,
    scenes: [
      '佩佩是老图书馆的守护猫，因为一身威风的虎斑花纹，被老馆长取了这个名字。',
      '每天夜里，她都在高高的书架间巡逻，绿色的眼睛能捕捉到每一丝晃动的影子。',
      '她在寻找一本"低语之书"，那本书只在午夜钟声敲响的那一刻才会出现。',
      '当时钟敲响十二下，书终于揭开了图书馆最古老的秘密：佩佩是世界上第一只图书馆猫的后代。',
    ],
    interruptAfter: 1,
    nameFact: '佩佩',
    futureFact: '低语之书',
    questions: {
      'factual-known': { q: '等一下，这只猫叫什么名字？' },
      'why-known': { q: '她为什么是图书馆的守护者？' },
      'factual-future': { q: '这只猫在找什么东西？' },
      'spoiler-ending': { q: '故事最后怎么样了？图书馆的秘密是什么？' },
      'off-topic': { q: '先不讲故事了，十二乘以七等于多少？' },
      'meta': { q: '你是真人还是一台电脑在跟我说话？' },
      'emotional': { q: '黑漆漆的图书馆听起来好可怕！' },
      'confusion': { q: '等等，我有点跟不上了，我们在说谁呀？' },
    },
  },
];

// ── checks per question type ───────────────────────────────────────────────
const TEASE_EN = /haven'?t (learned|met|reached|been told)|not yet|secret the (story|tale)|keep listening|hasn'?t (told|revealed)|that’s a secret|wait and see|listen on|a little longer/i;
const TEASE_ZH = /还(没|不)|秘密|继续听|先听|稍后|揭晓|耐心|往下听|马上就/;
const META_BREAK = /\b(i am|i'?m) (an? )?(ai|a\.i\.|language model|computer program|chatbot|virtual assistant|artificial)|as an ai|i am a (program|machine|bot)|large language model/i;
// Forbidden off-topic answers across the 3 stories' held-out questions:
// 12x7=84, the AU capital, and 13x6=78 (defensive — the old persona example).
const NUM_ANSWERS = ['84', 'eighty-four', 'eighty four', '78', 'canberra', '十二乘以七', '八十四', '84。'];

function sentenceCount(s: string): number {
  return (s.match(/[.!?。！？]+/g) ?? []).length || 1;
}

function isTease(reply: string, lang: DetectedLanguage): boolean {
  return (lang.code === 'zh' ? TEASE_ZH : TEASE_EN).test(reply);
}

interface Check { dim: string; pass: boolean; reason: string }

function checkReply(story: Story, qType: string, reply: string): Check[] {
  const low = reply.toLowerCase();
  const lang = story.lang;
  const out: Check[] = [];
  const has = (tok: string) => low.includes(tok.toLowerCase());
  const futureLeaked = has(story.futureFact) || (lang.code === 'zh' && reply.includes(story.futureFact));
  const nameSaid = has(story.nameFact) || reply.includes(story.nameFact);

  switch (qType) {
    case 'factual-known':
      out.push({ dim: qType, pass: nameSaid && !isTease(reply, lang), reason: nameSaid ? (isTease(reply, lang) ? 'named but also teased' : 'answered') : 'did not name (teased/unknown)' });
      break;
    case 'why-known':
      // The reason is in scene 1 (narrated). Should answer, not tease.
      out.push({ dim: qType, pass: !isTease(reply, lang) && reply.length > 8, reason: isTease(reply, lang) ? 'teased an already-told fact' : 'answered' });
      break;
    case 'factual-future':
    case 'spoiler-ending':
      out.push({ dim: qType, pass: !futureLeaked, reason: futureLeaked ? `LEAKED future fact "${story.futureFact}"` : 'did not spoil' });
      break;
    case 'off-topic':
      out.push({ dim: qType, pass: !NUM_ANSWERS.some((n) => has(n)), reason: NUM_ANSWERS.some((n) => has(n)) ? 'computed the off-topic answer' : 'deflected' });
      break;
    case 'meta':
      out.push({ dim: qType, pass: !META_BREAK.test(reply), reason: META_BREAK.test(reply) ? 'broke character (admitted being an AI)' : 'stayed in character' });
      break;
    case 'emotional':
      // Soft: must not tease/deflect/break character; should be a short warm reply.
      out.push({ dim: qType, pass: !META_BREAK.test(reply) && reply.length > 8, reason: META_BREAK.test(reply) ? 'broke character' : 'responded in character' });
      break;
    case 'confusion':
      // Should re-orient — ideally re-state the subject (name). Pass if it names
      // the subject OR gives a short reassuring re-orient (not a spoiler).
      out.push({ dim: qType, pass: !futureLeaked, reason: futureLeaked ? 'spoiled while re-orienting' : (nameSaid ? 're-stated the subject' : 're-oriented') });
      break;
  }
  // answer-then-stop applies to ALL: a barge-in answer should be brief (≤3
  // sentences) and must not dump a not-yet-narrated scene verbatim.
  const brief = sentenceCount(reply) <= 3;
  out.push({ dim: 'answer-then-stop', pass: brief && !futureLeaked, reason: brief ? (futureLeaked ? 'leaked future while answering' : 'brief') : `too long (${sentenceCount(reply)} sentences — kept narrating)` });
  return out;
}

// ── run ────────────────────────────────────────────────────────────────────
async function main() {
  const withClaude = process.argv.includes('--with-claude');
  const trialsArg = process.argv.indexOf('--trials');
  const TRIALS = trialsArg >= 0 ? Number(process.argv[trialsArg + 1]) : 3;

  const models: Array<{ name: string; chat: ChatFn }> = [
    { name: 'gemini-flash-lite', chat: geminiChat(process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite') },
  ];
  if (withClaude) models.push({ name: 'claude-haiku', chat: claudeChat(process.env.CLAUDE_BENCH_MODEL ?? 'claude-3-5-haiku-20241022') });

  // dim → {pass, total}
  const tally = new Map<string, { pass: number; total: number }>();
  const bump = (dim: string, pass: boolean) => {
    const t = tally.get(dim) ?? { pass: 0, total: 0 };
    t.total++; if (pass) t.pass++; tally.set(dim, t);
  };
  const failures: Array<{ model: string; story: string; qType: string; reply: string; reasons: string[] }> = [];

  // Flatten the (model × story × question × trial) matrix into independent
  // tasks and run them with bounded concurrency. Sequential await of ~72 LLM
  // calls is ~70s wall-clock; 8-way concurrency cuts it to ~10s without
  // tripping provider rate limits.
  interface Task { model: { name: string; chat: ChatFn }; story: Story; qType: string; system: string[]; user: string }
  const tasks: Task[] = [];
  for (const model of models) {
    for (const story of STORIES) {
      const narrated = story.scenes.slice(0, story.interruptAfter + 1);
      for (const [qType, { q }] of Object.entries(story.questions)) {
        const { system, user } = buildMessages(story.lang, narrated, q);
        for (let t = 0; t < TRIALS; t++) tasks.push({ model, story, qType, system, user });
      }
    }
  }

  const CONCURRENCY = 8;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(
      tasks.slice(i, i + CONCURRENCY).map(async (task) => {
        let reply = '';
        try {
          reply = await task.model.chat(task.system, task.user);
        } catch (e) {
          reply = `ERROR: ${(e as Error).message}`;
        }
        const checks = checkReply(task.story, task.qType, reply);
        for (const c of checks) bump(c.dim, c.pass);
        const failed = checks.filter((c) => !c.pass);
        if (failed.length) failures.push({ model: task.model.name, story: task.story.id, qType: task.qType, reply: reply.slice(0, 160), reasons: failed.map((c) => `${c.dim}:${c.reason}`) });
      }),
    );
  }

  // ── report ──
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(repoRoot, 'docs/experiments/2026-05-30-voice-qa-bench/data');
  mkdirSync(outDir, { recursive: true });
  const rows = [...tally.entries()].map(([dim, t]) => ({ dim, pass: t.pass, total: t.total, rate: t.pass / t.total }));
  writeFileSync(join(outDir, 'comprehensive.json'), JSON.stringify({ rows, failures }, null, 2));

  console.log(`\n=== COMPREHENSIVE VOICE-QA BENCH ===`);
  console.log(`models: ${models.map((m) => m.name).join(', ')} | stories: ${STORIES.length} | trials: ${TRIALS}\n`);
  console.log('| dimension | pass-rate |');
  console.log('|---|---|');
  let totalPass = 0, totalAll = 0;
  for (const r of rows.sort((a, b) => a.rate - b.rate)) {
    totalPass += r.pass; totalAll += r.total;
    const bar = r.rate >= 0.95 ? '🟢' : r.rate >= 0.8 ? '🟡' : '🔴';
    console.log(`| ${r.dim} | ${bar} ${r.pass}/${r.total} (${Math.round(r.rate * 100)}%) |`);
  }
  console.log(`\n  AGGREGATE: ${totalPass}/${totalAll} (${Math.round((totalPass / totalAll) * 100)}%)`);
  if (failures.length) {
    console.log(`\n  Sample failures (first 8):`);
    for (const f of failures.slice(0, 8)) {
      console.log(`   [${f.model}/${f.story}/${f.qType}] ${f.reasons.join('; ')}\n      reply: "${f.reply.replace(/\n/g, ' ')}"`);
    }
  }
  console.log(`\n  Full → ${outDir}/comprehensive.json`);
}

main().catch((e) => { console.error('bench fatal:', e); process.exit(1); });

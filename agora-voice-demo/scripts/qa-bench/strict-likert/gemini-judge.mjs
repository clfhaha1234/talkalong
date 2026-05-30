// Gemini-3.5-flash judge for the cross-judge sanity check.
//
// Reads a prepared judge prompt (same one Opus consumed) and calls
// Gemini-3.5-flash via the OpenAI-compatible endpoint. Output: same JSON
// array of per-case scores as Opus, so the aggregator + rank comparison
// work without changes.
//
// CRITICAL: reasoning_effort='minimal' is required for thinking-capable
// Gemini-3.x flash models (per earlier project finding) — otherwise the
// model spends the token budget on internal reasoning and returns a
// truncated body.
//
// Usage:
//   GOOGLE_API_KEY=... node scripts/qa-bench/strict-likert/gemini-judge.mjs \
//     --prompt /tmp/baseline-dev-prompt.txt \
//     --out    /tmp/baseline-gemini.json

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const promptPath = get('--prompt');
const out = get('--out');
const model = get('--model', 'gemini-3.5-flash');

if (!promptPath || !out) {
  console.error('usage: --prompt <txt> --out <json> [--model gemini-3.5-flash]');
  process.exit(2);
}
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_API_KEY required');
  process.exit(3);
}

const prompt = readFileSync(promptPath, 'utf8');

const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 4096,
    reasoning_effort: 'minimal',
  }),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(4);
}
const j = await res.json();
let raw = j.choices?.[0]?.message?.content ?? '';
if (raw.startsWith('```')) {
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}
const first = raw.indexOf('[');
const last = raw.lastIndexOf(']');
if (first < 0 || last < first) {
  console.error('no JSON array in response. raw:', raw.slice(0, 200));
  process.exit(5);
}
const parsed = JSON.parse(raw.slice(first, last + 1));
writeFileSync(out, JSON.stringify(parsed, null, 2));
console.log(`Wrote ${parsed.length} cases to ${out}`);

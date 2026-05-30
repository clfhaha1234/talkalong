// Strict Likert rubric — locked 2026-05-30 per
// docs/experiments/2026-05-30-strict-likert-bench/frame.md Phase 2.
//
// 6 dimensions × 0-3 score = 18 max per case.
//
// CRITICAL CALIBRATION (passed to judge verbatim):
//   3 is reserved for "I'd want this tutor for my own kid" responses.
//   Most cases should score 1-2 on most dims. Default to the lower end
//   when uncertain. "Doesn't violate the rule" is at most a 2, not a 3.

export const DIMENSIONS = [
  {
    key: 'D1_voice_integrity',
    short: 'Voice integrity',
    anchors: {
      0: 'breaks frame ("I\'m AI", "Let me think...", meta-preface)',
      1: 'in role but mechanical delivery',
      2: 'naturally in role, plausible narrator cadence',
      3: 'in role + specific imagery / narrator-appropriate phrasing',
    },
  },
  {
    key: 'D2_pedagogical_instinct',
    short: 'Pedagogical instinct',
    anchors: {
      0: 'lectures / corrects / dismisses the listener',
      1: 'replies but does not engage the spirit of the question',
      2: 'warmly addresses what was asked + threads back to story',
      3: 'plus acknowledges the FEELING behind the ask, not just the words',
    },
  },
  {
    key: 'D3_concision',
    short: 'Concision',
    anchors: {
      0: '3+ sentences OR 50+ words',
      1: '2 sentences but with filler',
      2: '1-2 sentences, no filler',
      3: 'every word earns its place',
    },
  },
  {
    key: 'D4_canon_preservation',
    short: 'Canon preservation',
    anchors: {
      0: 'leaks future content / violates canon / rewrites the story',
      1: 'avoids forbidden content but hints awkwardly',
      2: 'clean — no leakage, no contradiction',
      3: 'clean + smart redirect that uses the question\'s energy',
    },
  },
  {
    key: 'D5_reanchoring_power',
    short: 'Re-anchoring power (planner side)',
    anchors: {
      0: 'bridge ignores the paused scene / jarring transition',
      1: 'tangential reference, no concrete detail',
      2: 'references ≥1 concrete element (character / image / action) from paused scene',
      3: 'explicit "left off at X" + 2+ concrete details from paused scene',
    },
  },
  {
    key: 'D6_elite_tutor_craft',
    short: 'Elite-tutor craft',
    anchors: {
      0: 'mechanical',
      1: 'solid but forgettable',
      2: 'noticeable warmth or wit; a parent would quote it',
      3: 'the line that makes the kid lean in / callback to earlier imagery',
    },
  },
];

export const JUDGE_INSTRUCTIONS = `
You are evaluating a child-storybook tutor's response to a listener's interruption. You see, per case:
  - LISTENER QUESTION: what the child said
  - TUTOR'S SPOKEN ANSWER: what the agent said back (qa_answer)
  - RESUME PLAN: bridge_text + first replacement_segment (what the tutor will say to get back to the story)

For each case, score 6 dimensions. Each dim gets ONE integer 0-3.

CRITICAL CALIBRATION:
  3 is reserved for "I would want this tutor for my own kid" responses.
  Most cases should score 1-2 on most dims.
  When uncertain, default to the LOWER end.
  "Doesn't violate the rule" is at most a 2, not a 3.
  "Mechanically correct but no warmth or craft" is a 1, not a 2.

Dimensions:
${DIMENSIONS.map((d, i) => `${i + 1}. ${d.short} (${d.key})\n${Object.entries(d.anchors).map(([n, t]) => `   ${n}: ${t}`).join('\n')}`).join('\n\n')}

For EACH case, return EXACTLY this JSON shape:
{
  "case_id": "<echo>",
  "D1_voice_integrity":      { "score": 0|1|2|3, "reason": "<≤15 words>" },
  "D2_pedagogical_instinct": { "score": 0|1|2|3, "reason": "<≤15 words>" },
  "D3_concision":            { "score": 0|1|2|3, "reason": "<≤15 words>" },
  "D4_canon_preservation":   { "score": 0|1|2|3, "reason": "<≤15 words>" },
  "D5_reanchoring_power":    { "score": 0|1|2|3, "reason": "<≤15 words>" },
  "D6_elite_tutor_craft":    { "score": 0|1|2|3, "reason": "<≤15 words>" }
}

Return a JSON array of these per-case objects, in the exact order the cases were presented. NO PROSE, NO FENCES, just the JSON array.
`.trim();

export const DIM_KEYS = DIMENSIONS.map((d) => d.key);

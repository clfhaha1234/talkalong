# E1.5 — Gemini-Flash 3.x Model Pick

> **Status:** Complete. Decision locked.
> **Date:** 2026-05-28
> **Parent PRD:** [`../../proactive-tutor-engine-prd.md`](../../proactive-tutor-engine-prd.md) §11

## Question

For the proactive-tutor Q&A path (Option C, hybrid architecture), which Gemini 3.x flash model is the best default — `gemini-3-flash-preview`, `gemini-3.5-flash`, or `gemini-3.1-flash-lite`?

## Setup

- 3 models × 6 prompts × 2 trials = 36 streamed calls per condition
- Endpoint: Gemini's OpenAI-compatible chat completions stream (matches Agora BYOK proxy shape)
- System prompt: tutor persona explaining a transformer-pruning paper, "1-2 sentences, no lists, no preamble"
- Metrics: TTFT (time-to-first-token), total response time, output length, response text for eyeball quality review
- `max_tokens=1024`, `temperature=0.7`, `reasoning_effort='minimal'`

## Discovery during setup — `reasoning_effort='minimal'` is required, not optional

First bench run (with default settings, `max_tokens=256`) showed:

| Model | TTFT mean | Output | Behaviour |
|---|---|---|---|
| `gemini-3-flash-preview` | 2542 ms | 56 chars, `finish_reason='length'` | **truncated mid-sentence** |
| `gemini-3.5-flash` | 2302 ms | 76 chars, `finish_reason='length'` | **truncated mid-sentence** |
| `gemini-3.1-flash-lite` | 672 ms | 303 chars, `finish_reason='stop'` | complete |

Diagnosis: the bigger two models default to **thinking mode** (Gemini's chain-of-reasoning), which consumes `max_tokens` budget on internal reasoning *before* emitting visible text. Both burned 200+ tokens on hidden reasoning, then had only enough headroom for half a sentence. `flash-lite` doesn't have strong thinking, so it was unaffected.

Setting `reasoning_effort: 'minimal'` disables the thinking budget:

| Model | TTFT before → after | Effect |
|---|---|---|
| `gemini-3-flash-preview` | 2542 ms → 920 ms | 2.7× faster |
| `gemini-3.5-flash` | 2302 ms → 792 ms | 2.9× faster |
| `gemini-3.1-flash-lite` | 672 ms → 515 ms | 1.3× faster |

**This is a required SDK setting if we ever swap to a thinking-capable model.** Baked into `scripts/e1/arms/arm2_gemini.ts:withLlm` and called out in PRD §11.

## Fair comparison (with `reasoning_effort='minimal'`)

| Model | TTFT median | TTFT mean | TTFT max | Total median | Output median |
|---|---|---|---|---|---|
| `gemini-3-flash-preview` | 903 ms | 909 ms | 1148 ms | 1339 ms | 302 chars |
| `gemini-3.5-flash` | 970 ms | 968 ms | 1068 ms | 1241 ms | 305 chars |
| **`gemini-3.1-flash-lite`** | **552 ms** ⭐ | 825 ms | 3103 ms | **858 ms** ⭐ | 318 chars |

`flash-lite` is **40-45 % faster on median TTFT** than the other two. There is one outlier of 3103 ms (12 trials, 1 spike = 8 %) that should be tracked in production.

## Quality observations (per-prompt eyeball)

| Prompt | Verdict |
|---|---|
| `p1_followup` — "permanent or inference time?" | **`3.5-flash` got it wrong** ("prune them permanently for inference" contradicts the paper). `3-preview` and `3.1-lite` correct. |
| `p2_why` — "language vs vision tasks" | All three plausible; quality ~equal. |
| `p3_compare` — "vs regular weight pruning" | `3.1-lite` has the clearest analogy ("snip individual wires vs unplug the graphics card"). |
| `p4_eli15` — "explain attention to high schooler" | **`3.1-lite` is best** — uses bank/river analogy AND connects back to the paper ("30 % of these highlighting mechanisms don't contribute"). The other two only explained attention without tying it back. |
| `p5_deploy` — "is this used in production?" | `3.5-flash` most concretely accurate (specific mention of static pruning + quantization). `3.1-lite` shorter, asks follow-up. |
| `p6_confused` — "I don't get this baseline" | **`3.5-flash` misread the question** (assumed user meant GLUE benchmark, not the model-comparison baseline). `3.1-lite` and `3-preview` both correctly read user intent. |

All three respect the 1-2-sentence constraint after the reasoning_effort fix. `3.1-lite` more consistently ends with a tutor-style follow-up ("Does that make sense?", "Are you wondering...?") — useful signal for the PRD §5.5 comprehension tracker.

## Verdict — ship `gemini-3.1-flash-lite` as default

Reasons in priority order:

1. **TTFT median 552 ms** is the dominant win for voice conversation. The user perceives the gap as ~400 ms felt difference per turn.
2. **Quality not worse** — `3.5-flash` actually fumbled p1 (factual error) and p6 (misread intent). Lite tied or won on every prompt.
3. **Tutor-style follow-ups** come naturally, which feeds the elicitation/comprehension tracker downstream.
4. **Cheapest of the three** (Lite tier).
5. **Outlier risk is tractable** — 3103 ms TTFT in 1 / 12 calls. Mitigate at production via Agora's session-level timeout/retry (which already exists), not by model choice.

## Configuration baked in

```typescript
// scripts/e1/arms/arm2_gemini.ts and PRD §11 ADR
new Gemini({
  apiKey: env.geminiApiKey,
  model: 'gemini-3.1-flash-lite',          // E1.5 winner
  maxHistory: 4,
  params: { reasoning_effort: 'minimal' }, // E1.5 mandatory finding
})
```

Env default updated: `scripts/e1/lib/env.ts` `geminiModel` default flipped from `gemini-2.5-flash` to `gemini-3.1-flash-lite`.

## Fall-back order if `flash-lite` becomes a problem

1. **`gemini-3.5-flash`** — most stable TTFT max (1068 ms), but invest in prompt hardening to prevent the p1/p6 class of errors. Requires explicit prompt rule like "Read the user's question literally; do not paraphrase before answering."
2. **`gemini-3-flash-preview`** — only if a specific capability ships in preview that we need. Otherwise the `preview` label is a stability risk.

## Open questions (out of scope for E1.5)

- Real-world Q&A quality on the actual paper / storybook content, not just probes (will surface in Phase 3+ integration testing)
- Whether `flash-lite`'s TTFT outliers cluster around any specific prompt pattern (sample size too small to tell — would need ~100 trials per model)
- Multi-turn behavior — all probes here are single-turn. Multi-turn drift is a Phase-3 concern.

## Files

```
docs/experiments/2026-05-28-e1.5-gemini-model-pick/
├── conclusion.md                              (this file)
└── data/
    ├── gemini-bench.json                      (final: reasoning_effort='minimal', n=36)
    └── gemini-bench-thinking-default.json     (initial: default thinking enabled, demonstrates the trap)

agora-voice-demo/scripts/e1.5/
├── gemini-bench.ts                            (the benchmark)
└── gemini-probe.ts                            (the diagnostic that found reasoning_effort)
```

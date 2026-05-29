# Conclusion — Storybook narration immersion break

**Date:** 2026-05-28
**Status:** Pivoted from auto-lab to root-cause patch (multi-cause bug, not a single comparative arm question)

## Question (verbatim from Phase 0)

The agent currently prefaces every narration with "Got it — let me read this through for you." before reading scene 1. This breaks the storybook teacher illusion. What change removes this preface without breaking the rest of the flow?

## Result — auto-lab discipline says: STOP the comparison

The probe (`scripts/probe-greeting.ts`, 9 trials × 3 arms, `getTurns()` ground truth) showed **zero greeting turns played across all 3 arms** in the headless server-side path. None of baseline / arm A / arm B distinguishable on this metric.

Reasons that's not informative for our actual UX bug:
1. No RTC subscriber in the probe — Agora may only fire greeting when there's a listener
2. The "sure, let me start read..." the user paraphrased is **plausibly any of three independent sources**, not necessarily the configured Agora greeting

The right move per auto-lab `When NOT to Use`: when first-principles reasoning can find the bug, **just fix it** instead of A/B-testing arms.

## Real root causes (3 independent bugs, all need fixing)

### Bug 1 — `DEFAULT_GREETING` hardcoded in `lib/orchestrator/index.ts:73`

```typescript
const DEFAULT_GREETING = `Got it — let me read this through for you.`;
```

Even if Agora gates this on having a listener, in production the browser IS the listener. Setting it to `""` and never overriding from the lesson route removes any chance of this firing.

### Bug 2 — `DEFAULT_PERSONA` is a generic tutor, not a storybook narrator

```typescript
const DEFAULT_PERSONA = `You are Ada, a warm and sharp voice tutor. The user has loaded a piece of content and asked you to read it aloud. When the user interrupts to ask a question, answer in 1-2 sentences and stop. Do not paraphrase the content unless asked.`;
```

This is what the LLM gets as system prompt for Q&A turns (`session.say()` bypasses LLM, so narration is unaffected). For storybook mode the LLM's answers during Q&A should stay in character as the narrator, not break to a chipper tutor.

### Bug 3 — **The biggest one: `composeLesson` Phase A treats user input AS the script**

`lib/lesson/scene-composer.ts` is a deterministic stub: it splits the user's input text into scenes and reads it back verbatim. So when the user types **"Tell me the story of Einstein's special relativity..."**, the agent reads aloud:
> Scene 1: "Tell me the story of Einstein's special relativity — how he figured out that time can stretch and bend."
> Scene 2: "Aim it at a curious 10-year-old."

The user hears their own prompt read back as the lesson content. That's **the dominant cause** of the "out of character" feeling. The greeting is small noise on top.

This was an intentional Phase A short-cut per user's earlier decision: *"你可以先全假跑通，然后再换成真LLM，也可以加 cache"*. We chose to ship the UI loop end-to-end with a fake composer first; Phase B = real LLM-driven script generation, with cache so retries on the same input are instant. Phase A's stub has done its job; we need Phase B now.

## What to ship as the fix

Single multi-piece commit (because the 3 bugs are tightly coupled in the user's perception):

1. **`lib/orchestrator/index.ts`:**
   - `DEFAULT_GREETING = ''` (empty string — never editorialize)
   - `DEFAULT_PERSONA` rewritten to "storybook narrator, in character, never preface" rules

2. **`lib/lesson/script-generator.ts`** (new) — Gemini-Flash-Lite-driven script generation:
   - Input: user's request text (e.g., "Tell me about Einstein's relativity")
   - Output: ~5-6 scene story script with narration_text + image_prompt per scene, deterministic JSON shape

3. **`lib/lesson/scene-composer.ts`** — Switch over from text-splitter stub to calling `script-generator`. Keep the deterministic stub as a fallback when LLM is unavailable / errors out, so the UI loop never fails completely.

4. **Cache the LLM script too** — same content-hash strategy as image-gen (`public/lesson-cache/scripts/{sha256(input)}.json`). Re-running same input → instant scenes ready.

## Discipline self-audit

- [x] Pre-registered metric (binary "first turn is api_speak, not greeting")
- [x] Pilot run validated all metric fields populated (got turn data)
- [x] Variance baseline not needed — single deterministic measurement
- [x] Cross-judge sanity not applicable — objective turn-type field
- [x] Per-row diffs read — all 9 trials showed identical pattern → no signal to refine
- [x] 3-iter cap respected (zero iterations because no signal)
- [x] **Falsification accepted as a finished result** — primary metric ("is greeting the cause?") was inconclusive in this measurement setup; first-principles pivot to fix three known-bad inputs.

## What to test next

Whether the LLM-generated script is actually *good storytelling* (engagement, age-appropriateness, faithfulness to the source material). That's a `self-improve` task once we have a real script generator — not an auto-lab arms-comparison.

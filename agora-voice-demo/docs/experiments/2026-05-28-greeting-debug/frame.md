# Experiment — Storybook narration immersion break ("Got it…")

**Date:** 2026-05-28
**Skill:** auto-lab (compressed)
**Status:** Phase 0 locked

## Question

The agent currently prefaces every narration with "Got it — let me read this through for you." before reading scene 1. This breaks the storybook teacher illusion. What change removes this preface without breaking the rest of the flow?

## Hypothesis

The preface is NOT the LLM editorializing. It IS the hardcoded `DEFAULT_GREETING` constant at `lib/orchestrator/index.ts:73`, which Agora plays at session start before our narrator's `say()` calls queue. The narrator uses `priority: 'APPEND'` so it does not interrupt the greeting; it waits for greeting to drain first.

Persona text (also at `index.ts:71`) only affects LLM-driven Q&A turns, NOT the storybook narration itself (narrator's `say()` calls bypass the LLM and feed text directly to TTS). So persona changes won't affect the bug, but should be updated for in-character Q&A.

## Baseline (current production)

```typescript
const DEFAULT_PERSONA = `You are Ada, a warm and sharp voice tutor. The user has loaded a piece of content and asked you to read it aloud. When the user interrupts to ask a question, answer in 1-2 sentences and stop. Do not paraphrase the content unless asked.`;
const DEFAULT_GREETING = `Got it — let me read this through for you.`;
```

## Arms

### Arm A — empty greeting, storybook persona

```typescript
const DEFAULT_PERSONA = `You are the warm voice of a storybook narrator reading aloud to a curious child. Stay in character at all times — you ARE the story's voice, not an assistant. When the listener interrupts with a question, answer in 1-2 short sentences as a teacher would, then stop. Never preface or comment on your reading. Never say things like "okay", "let me", "I'll", "sure", or "let's continue" — just continue the story. No bullet points, no narration of your own actions.`;
const DEFAULT_GREETING = ``;
```

### Arm B — in-character first-word greeting, storybook persona

Same persona as Arm A. Greeting is dynamic per session, set by the lesson route to the first ~6 words of `scenes[0].narration_text`. This guarantees the first audible utterance is on-topic for the lesson, even if Agora insists on playing a greeting.

## Metric

**Primary:** Does the first audible utterance from the agent (captured via `session.getHistory()` after narration drains) start with the same first 6 words as `scenes[0].narration_text`? Binary: YES/NO per trial.

**Secondary:** Total dead-air before first content word (ms, measured via RTM `agent-state` SPEAKING transition timestamp minus session-start timestamp).

## Effect-size threshold

This is a binary correctness experiment, not a percentage gain. Winner must hit 5/5 trials YES, baseline by definition is 0/5 (we've already heard the preface every time).

## Trials

5 trials per arm using the same input text (Einstein preset), to absorb any TTS/Agora variance. If baseline + winning arm both run successfully, we're done.

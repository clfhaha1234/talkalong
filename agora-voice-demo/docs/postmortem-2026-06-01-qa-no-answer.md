# Postmortem — "无视我的QA": the tutor never answered questions (2026-06-01)

## Summary

For weeks the storybook tutor appeared to **ignore questions** — you'd barge in,
the narration would (eventually) hush, but no answer ever came. We treated it as
a real-time audio / barge-in problem and shipped a long series of audio-chain
fixes. The actual root cause was **two stacked bugs**, the shallow one masking
the deep one:

1. **(client) The buffered narration smothered the reply.** `sendText(INTERRUPTED)`
   does **not** flush `say()`-injected narration TTS, so even when the agent
   produced a reply it never got a voice turn.
2. **(server) The agent's LLM call returned 401.** The orchestrator used Agora's
   **OpenAI reseller preset** (`new OpenAI({ model: 'gpt-4o-mini' })` with no
   key). On this project the reseller credentials return **HTTP 401** from
   `api.openai.com`; the toolkit can't decode the `text/plain` body and surfaces
   it as `agent_error llm:505`. So **no QA answer — voice or typed — ever worked.**

Both are fixed. The full barge-in → answer → resume loop is verified live on
Render (typed e2e 3/3; voice confirmed by hand — "丝滑").

## Timeline (compressed)

- Symptom reported repeatedly as "还是无视我的话" across many deploys.
- Audio-chain fixes shipped: instant client hush, dynamic silence windows,
  `branch_id` staleness guards, back-channel filtering, stale-closure fix,
  subtitle reveal. Each helped the *feel* but the agent still didn't answer.
- Added **diagnostic seams** (`?voicelog=1` → `send_uid` / `sent_ok|err` /
  `agent_uid` / `agent_reply` / `agent_error`). These revealed: the agent's
  in-branch transcript was **the narration still playing**, not a reply → bug #1.
- Fixed bug #1 (interrupt before send). The reply then *attempted* to generate
  and immediately surfaced `agent_error llm:505` on every run (3/3) → bug #2.
- An agent-error probe printed `error.message`:
  `505 401, message='Attempt to decode JSON with unexpected mimetype: text/plain', url='https://api.openai.com/v1/chat/completions'`
  → the reseller OpenAI credential is rejected with 401.
- Routed the agent LLM to **Gemini's OpenAI-compatible endpoint** with our own
  `GOOGLE_API_KEY` (already provisioned + working — lesson generation and the
  resume planner use the same key). Typed e2e went 3/3 with real, varied answers
  naming the cat; server logs clean.

## Root cause

The agent's LLM was the **only live LLM call that the test suite never
exercised** — and it was misconfigured. STT (Deepgram) and TTS (MiniMax) ran on
Agora's managed reseller and worked; the LLM reseller did not. Because narration
is injected via `say()` (direct TTS, **no LLM call**), the *first* real LLM
invocation in any session is the answer to a question — which always 401'd.

## Why no eval caught it (the benchmark gap)

Every unit/integration test mocked the LLM (`withLlm() { return this }`), and the
QA bench fed transcripts to a *judge* model rather than driving the *product's*
agent. **Nothing ever made the live agent answer a live question.** A broken LLM
credential has no compile-time or unit-test signal — only an outcome-level e2e
that makes the agent answer can catch it.

Worse: the one outcome-level test we did have (`verify-typed-qa.mjs`) was itself
**dishonest** — its `pass` only checked "not a narration leak", so the agent's
error-fallback message ("I'm having trouble answering right now") *passed*. That
false green hid the bug even after we were looking right at it.

## Fixes

| # | Layer | Change | Commit |
|---|---|---|---|
| 1 | client | Interrupt narration **before** the typed reply (sequence: enter branch w/ `interrupt_audio:true` → await `/branch-started` → 250ms settle → `sendText`). `beginVoiceBranch` returns the POST promise so the typed path can await it. | `56aec21` |
| 2 | server | Route agent LLM to **Gemini OpenAI-compat** endpoint with `GOOGLE_API_KEY` (model via `GEMINI_TUTOR_MODEL`, default `gemini-3.1-flash-lite`). STT/TTS reseller untouched. | `74168ac` |
| 3 | test | `verify-typed-qa` now **requires the answer to name the expected entity** (not just `!leak`), and drops the false "guardian of" leak marker (it's the cat's role, present in correct answers). | `148c4b6` |

## Lessons

1. **An outcome-level e2e that exercises the live credential is non-negotiable.**
   Mocks prove wiring, not that the third-party call works. If a path calls an
   external model in prod, one test must make that exact call for real.
2. **A passing test that can't fail for the right reason is worse than no test.**
   `verify-typed-qa` passed the error-fallback. Acceptance must assert the
   *positive* outcome (the answer names the cat), not merely the absence of a
   known-bad pattern.
3. **Read the full error, not the code.** `llm:505` looked like an HTTP-version
   error; the *message* (401 from api.openai.com) was the whole story. We spent
   weeks on the audio chain because we never surfaced `error.message`.
4. **Decode symptoms by layer.** "Agent ignores me" spanned UI hush, server
   interrupt, and the LLM credential. The instrumentation that finally cracked it
   tagged each seam to a layer so we could see *where* the chain broke.
5. **Prefer one provider you control.** Routing the agent LLM to the same Gemini
   key as generation removed a second, opaque credential path (the reseller) and
   unified the stack.

## Prevention

- `verify-typed-qa.mjs` is now the credential canary — it makes the live agent
  answer and asserts the answer is correct. Run it post-deploy.
- If voice QA ever goes silent again: open `?voicelog=1` and check the
  `agent_error` seam for `llm:<code>` **first** — that's the credential, not the
  audio chain. (Recorded in agent memory `llm-reseller-401-no-answer`.)

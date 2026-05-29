# 2026-05-29 — Language-switch barge-in: root cause + eval

## Symptom (user report)

> "我中文打断它，让它用中文来讲，它听完之后不为所动，继续口述原本的故事。"
> (Interrupted in **spoken Mandarin** asking it to switch to Chinese; the tutor kept narrating the original English story unchanged.)

## TL;DR

The bug is **not** in the resume planner. The planner already switches to Chinese
correctly when the request reaches it as clean text (proven by the qa-bench `C1`
case across every historical run). The real root cause is **upstream, in STT**:
the speech recognizer is pinned to English (`DeepgramSTT nova-3, en-US`), so
spoken Mandarin is transcribed to English garbage and the "switch to Chinese"
intent never reaches the persona or the planner.

## The language stack (where a spoken-Chinese request can die)

| Layer | Code | Handles Chinese? |
|---|---|---|
| **STT** | `DeepgramSTT({ model: 'nova-3', language: 'en-US' })` — [lib/orchestrator/index.ts](../../../lib/orchestrator/index.ts) | ❌ **en-US only — this is the bug** |
| Persona (live Q&A answer) | `DEFAULT_PERSONA` + `OpenAI gpt-4o-mini` | ✅ answers in Chinese once it receives Chinese text |
| Resume planner | `SYSTEM` in [lib/orchestrator/resume-planner.ts](../../../lib/orchestrator/resume-planner.ts) | ✅ switches narration to Chinese (qa-bench `C1`, every run) |
| TTS | `MiniMaxTTS speech_2_8_turbo` | ✅ MiniMax renders Mandarin natively (see `cases.json` C1 `rubric_correction_note`) |

So three of the four layers already work. Only STT blocks the spoken-Chinese path.

## Why it's not a one-line config flip

`language: 'multi'` looks like the fix, but **Deepgram nova-3's multilingual
code-switching model does not include Mandarin** — it covers EN/ES/FR/DE/HI/IT/JA/NL/RU/PT.
Mandarin exists only as a *monolingual* nova-3 model (`zh`), which would break the
default English narration.

- https://developers.deepgram.com/docs/multilingual-code-switching
- https://developers.deepgram.com/docs/models-languages-overview

Further constraint: in the Agora `agora-agent-server-sdk`, only **Deepgram
(nova-2/nova-3)**, **OpenAI** (LLM/TTS), and **MiniMax** (TTS) have the keyless
"reseller preset" path. Every multilingual STT (OpenAI Whisper, Speechmatics,
Google, Azure, Amazon, AssemblyAI) **requires an explicit API key** and is not on
the managed reseller path — so adopting one needs a key + Agora-side provisioning.

## Two product positions

- **(A) English-spoken command → Chinese narration.** Works **today**, no code
  change: en-US STT transcribes "please tell it in Chinese", the planner switches
  the narration to Chinese (verified), MiniMax renders it.
- **(B) Chinese-spoken command → Chinese narration** (what the user tested).
  Requires a multilingual STT that auto-detects EN+ZH. This is an architectural
  change with external dependencies (vendor key + Agora provisioning) and could
  not be verified in this environment (no live mic / Agora console).

## Recommended fix for (B) — NOT yet applied (needs external verification)

Switch STT to a multilingual auto-detecting vendor. **OpenAI Whisper** is the
strongest candidate (auto-detects language incl. Mandarin, and OpenAI is already
provisioned for the LLM), pending confirmation that Agora ConvoAI supports
`OpenAISTT` streaming and that an OpenAI key is available to the managed agent:

```ts
// lib/orchestrator/index.ts — buildAgent()
.withStt(new OpenAISTT({ apiKey: process.env.OPENAI_API_KEY!, model: 'whisper-1' }))
// (auto-detects spoken language, incl. Mandarin; no `language` pin)
```

**The STT vendor swap was deliberately NOT applied** because it cannot be verified
here with real audio, and a blind swap risks breaking the working English pipeline
(the demo the user just ran). It needs: (1) confirm Agora provisions the vendor +
key, (2) real-audio test: speak Mandarin → confirm transcript is Mandarin →
confirm narration switches.

## What WAS verified this round

- **Resume planner handles Chinese** given clean text — qa-bench `C1`
  (`能不能接下来用中文讲故事？`) → Chinese bridge + segments, canon preserved,
  `source=llm`. Deterministically checked (CJK-dominant) by the new grader.
- **Orchestrator resume wiring** — new integration test
  [lib/orchestrator/index.qa-resume.test.ts](../../../lib/orchestrator/index.qa-resume.test.ts)
  drives the real `handleQaEnded` with a Chinese plan and asserts the Chinese
  bridge plays via `INTERRUPT`, the paused segment is rewritten to Chinese, and
  the `active_scene_changed` / `bridge_completed` events fire.
- **A speculative planner-prompt edit was reverted** — the bench proved the
  planner already switches without it, so the edit was unnecessary scope and a
  potential source of English-case drift.

## Un-automatable surfaces (deferred, by nature)

- Real-voice Mandarin barge-in end-to-end (needs live mic + human).
- TTS audio language/quality (audible only).
These require a human in front of the running app; they are out of reach of CI.

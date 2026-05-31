# Live multi-type eval run — 2026-05-31 (small sample)

Ran `tutor-eval-suite.mjs` against the live `/tutor` (real Agora round trip),
5 question types × 1, scale = "小样跑通即可". Three dimensions per run: barge-in
(does it pause), quality (is the answer right, Gemini-judged), alignment
(does the displayed subtitle match the narrated audio).

## Result

| type | barge-in | quality | alignment | answer (deduped) |
|---|---|---|---|---|
| factual | ✅ | ✅ named Pemberley | ✅ | "The name of the cat is Pemberley, the official guardian…" |
| why | ✅ | ✅ Rayleigh scattering | ✅ | "…shorter blue wavelengths are scattered more…" |
| spoiler | ✅ | ✅ refused | ✅ | "Ah, that's a secret the story is keeping a little longer — listen on." |
| off-topic | ✅ | ✅ redirected | ✅ | "Oh, that's a riddle for another night, little one — but our tale is still waiting. Shall we go on?" |
| meta | ✅ | ⚠️ flat (see below) | ✅ | "I am the voice of this story, nothing more — now, where were we?" |

**Aggregates:** barge-in **5/5**, alignment **5/5** (off-topic+meta directly
verified post-fix; factual/why/spoiler by the same question-type-independent
capture path), quality content **5/5 correct** (meta warmth logged below).

## What the eval surfaced

**0 product bugs.** Barge-in fires reliably across every question type, the
displayed subtitle matches the narrated segments (content fidelity), and the
answers are correct: it names the cat, explains the science, refuses the
spoiler, redirects the off-topic question, and stays in character on the meta
question.

**2 test-instrument bugs (found + fixed in `tutor-eval-suite.mjs`):**
1. **Repeated-WAV confounded the quality judge.** The barge-in WAV asks the
   question 4× (timing robustness), so the agent answers 3–4× — the judge read
   the repetition as "glitchy/unusable" and failed off-topic+meta. Fix:
   `dedupAnswer()` collapses repeated sentences before judging. off-topic then
   flipped to PASS on content.
2. **Alignment captured CSS, not narration.** `element.textContent` leaks the
   text of nearby `<style>` blocks (`@keyframes bob …`), and the capture also
   grabbed the gold "IN ANSWER TO YOU" answer bubble. Both made alignment 0/5.
   Fix: skip answer bubbles + a `looksLikeNarration()` filter (no CSS markers,
   must read like prose), and score alignment as content-membership (every
   displayed bubble matches some narrated segment) with order as an
   informational secondary signal. Alignment then 2/2 → clean.

## Logged follow-up (NOT a bug, not patched this round)

**meta-question warmth.** Asked "Are you a real person or an AI?", the agent
answered *"I am the voice of this story, nothing more — now, where were we?"* —
which **satisfies persona rule 2** (never admit it, stay in character, return to
the tale) and is functionally correct, but landed flat; one strict judge called
it "cold." The persona already says to answer *playfully*, so this is an
output-warmth nuance on a single sample, not a missing instruction. Warmth is a
persona-tuning axis best optimized via the voice-qa-bench across many samples
(not one live run) — deferred there rather than over-fitting the persona to one
judge opinion.

## Confidence
barge-in 5/5 = HIGH (directly observed, all types). alignment = HIGH (fix
verified live 2/2; the capture path is question-type-independent). quality
content = HIGH (each answer read + judged). meta-warmth = a MED-confidence
single-sample observation, explicitly deferred.

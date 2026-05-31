# talkalong — FAQ

**Why is the demo a children's storybook and not, say, a paper walkthrough?**
The PRD's primary target was a paper walkthrough (clearest main-line structure, sharpest
pain point — researchers reading dense PDFs need this more than kids need bedtime stories).
The storybook ended up shipping first because it's the **highest-stakes correctness setting**:
you cannot fake continuity in front of a 6-year-old. If the engine handles "wait why is the
bark silver — and where's the fox now?" across back-to-back interrupts without losing the
thread, it handles anything. Same engine, different content layer.

(The story's *language* follows the topic you type — type it in Chinese, get a Chinese story.
Switching language by *voice* mid-story isn't supported yet: speech-to-text is English-only
for now, so a spoken non-English interrupt won't transcribe. That's a roadmap item, not a
limitation of the orchestrator.)

**Doesn't Agora already do this?**
Agora does voice I/O — TTS, STT, interrupt, turn detection, the latency budget. Agora
explicitly does **not** do: structuring content into a teachable script, maintaining main-line
progress state, deciding when a Q&A is semantically over, or incrementally re-scripting after
an interrupt. That's the brain. We rent the mouth and ears. (See
[architecture.md](architecture.md).)

**Why same agent channel for narration AND Q&A?**
Two channels means two interrupt pipelines and a voice-character swap mid-conversation. Same
channel + v2.6 text-injection means narration is just "agent output we pushed" and Q&A is
"agent output it generated" — Agora can't tell them apart, so neither can the listener. Full
rationale + the rejected designs: [architecture.md](architecture.md).

**Why a small golden bench and not 50 fuzzed cases?**
Each case is a distinct interrupt class with a locked rubric. Adding a case means writing its
"right recovery" by hand — you can't fuzz this; the judge is structural, not stylistic. We grow
the set when we *ship a bug the existing cases didn't catch* (the language-mirroring case was
added the day we caught that regression in prod). The bench is hand-grown the same way a unit
test suite is.

**Why doesn't talkalong auto-tune the persona prompt?**
A prompt the system tunes against its own bench is a prompt that drifts toward the bench. We
use the bench as a **regression gate**, not an optimizer — humans propose the prompt change,
the bench tells us if anything broke. See [`scripts/qa-bench/README.md`](../agora-voice-demo/scripts/qa-bench/README.md).

**Can I use a different voice provider?**
Yes — the orchestrator only depends on (a) text-injection into a live channel and (b)
voice-based auto-interrupt. Any provider that exposes both will work; we currently use Agora
because their v2.6 SDK is the only one that ships both today.

**Can I use this for non-storybook content?**
Yes — that's the whole point. The orchestration layer is content-agnostic; only
[`agora-voice-demo/lib/lesson/`](../agora-voice-demo/lib/lesson) is storybook-specific (5-scene
structure, illustration generation, age-8-12 voice). Replace it with a paper-segmenter,
doc-segmenter, or museum-tour-segmenter and the engine carries.

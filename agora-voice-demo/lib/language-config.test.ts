// Unit tests for the per-language config selectors + the B2 storybook
// injection. The storybook injection is the fix for the "what's the cat's
// name?" regression (2026-05-30): the Agora voice AI never received the
// narrated text via session.say(), so it had no context to answer factual
// questions and defaulted to "we haven't learned that yet".
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  ENGLISH_PERSONA,
  STORYTELLER_VOICE_ID,
  STT_LANGUAGE,
  STT_MODEL,
  buildStorytellerSystemMessage,
  personaForLanguage,
  personaWithStorybook,
  type DetectedLanguage,
} from './language-config';

const ZH: DetectedLanguage = { code: 'zh', name: 'Chinese (Simplified or Traditional)' };
const EN: DetectedLanguage = { code: 'en', name: 'English' };

describe('voice + STT are language-independent stop-gaps', () => {
  it('one voice for everything', () => {
    expect(STORYTELLER_VOICE_ID).toBe('English_UpsetGirl');
  });
  it('STT is English-only (先凑合)', () => {
    expect(STT_MODEL).toBe('nova-3');
    expect(STT_LANGUAGE).toBe('en-US');
  });
});

describe('personaForLanguage', () => {
  it('English persona for en', () => {
    expect(personaForLanguage(EN)).toBe(ENGLISH_PERSONA);
  });
  it('Chinese persona for zh (non-empty, CJK present)', () => {
    const p = personaForLanguage(ZH);
    expect(p).not.toBe(ENGLISH_PERSONA);
    expect(/[一-鿿]/.test(p)).toBe(true);
  });
  it('default language resolves to English persona', () => {
    expect(personaForLanguage(DEFAULT_LANGUAGE)).toBe(ENGLISH_PERSONA);
  });
});

describe('buildStorytellerSystemMessage (single source of truth, prod + bench)', () => {
  const scenes = [{ text: 'Pemberley guards the library.' }, { text: 'She patrols the shelves.' }];

  it('no scenes → just the persona', () => {
    expect(buildStorytellerSystemMessage(ENGLISH_PERSONA, [])).toBe(ENGLISH_PERSONA);
  });

  it('merges persona + numbered story-so-far into ONE string (the merge-fix format)', () => {
    const msg = buildStorytellerSystemMessage(ENGLISH_PERSONA, scenes);
    expect(msg.startsWith(ENGLISH_PERSONA)).toBe(true); // persona first (not dropped)
    expect(msg).toContain('narrated to the listener SO FAR');
    expect(msg).toContain('Scene 1: Pemberley guards the library.');
    expect(msg).toContain('Scene 2: She patrols the shelves.');
    // exactly ONE merged message (no scene 3 — only narrated-so-far, no spoilers)
    expect(msg).not.toContain('Scene 3:');
  });

  it('honors a persona override (config.persona_prompt path)', () => {
    const custom = 'CUSTOM PERSONA';
    expect(buildStorytellerSystemMessage(custom, scenes).startsWith(custom)).toBe(true);
  });

  it('de-overfit: the prod persona no longer hardcodes the exact bench questions', () => {
    // The bench questions ("13 times 6", "Are you a robot?") must NOT be baked
    // into the shipped persona (that was train/test contamination — removed).
    expect(ENGLISH_PERSONA).not.toContain('13 times 6');
    expect(ENGLISH_PERSONA).not.toContain('Are you a robot');
  });
});

describe('personaWithStorybook (B2 — voice AI gets full context)', () => {
  const scenes = [
    { id: 's1', narration_text: 'Barnaby was a cat who lived in the old library.' },
    { id: 's2', narration_text: 'One night he found a book of stars left open.' },
    { id: 's3', narration_text: 'He chased the paper stars off the page.' },
  ];

  it('includes EVERY scene narration (the cat-name fix — Barnaby must be present)', () => {
    const p = personaWithStorybook(EN, scenes);
    expect(p).toContain('Barnaby');
    expect(p).toContain('book of stars');
    expect(p).toContain('chased the paper stars');
  });

  it('tags each scene with its id so the agent can locate facts', () => {
    const p = personaWithStorybook(EN, scenes);
    expect(p).toContain('[s1]');
    expect(p).toContain('[s2]');
    expect(p).toContain('[s3]');
  });

  it('keeps the base persona at the front (instructions not wiped)', () => {
    const p = personaWithStorybook(EN, scenes);
    expect(p.startsWith(ENGLISH_PERSONA)).toBe(true);
  });

  it('returns the base persona unchanged when there are no scenes', () => {
    expect(personaWithStorybook(EN, [])).toBe(ENGLISH_PERSONA);
  });

  it('localises the storybook header for zh (anti-spoiler instruction in Chinese)', () => {
    const p = personaWithStorybook(ZH, scenes);
    // Chinese base persona present...
    expect(p.startsWith(personaForLanguage(ZH))).toBe(true);
    // ...and the injected header references the secret-tease rule in Chinese.
    expect(p).toContain('剧透');
    // Scene bodies still injected verbatim.
    expect(p).toContain('Barnaby');
  });
});

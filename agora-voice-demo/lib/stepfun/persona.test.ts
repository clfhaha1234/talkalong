import { describe, it, expect } from 'vitest';
import { looksLikeMicCheck, looksLikeNarrationEcho } from './persona';

const STORY =
  'When the moon rose over the library, Pemberley the cat began her quiet nightly patrol between the tall shelves.';

describe('looksLikeNarrationEcho — false-barge / echo guard', () => {
  it('flags a verbatim narration chunk (mic caught the playback)', () => {
    expect(looksLikeNarrationEcho('Pemberley the cat began her quiet nightly patrol', STORY)).toBe(true);
  });

  it('flags a near-verbatim echo with light STT noise (high word overlap)', () => {
    expect(looksLikeNarrationEcho('when the moon rose over the library Pemberley the cat', STORY)).toBe(true);
  });

  it('does NOT flag a real question (low overlap with the story)', () => {
    expect(looksLikeNarrationEcho('What is the name of the cat?', STORY)).toBe(false);
    expect(looksLikeNarrationEcho('How does the story end?', STORY)).toBe(false);
    expect(looksLikeNarrationEcho('Why does she patrol at night?', STORY)).toBe(false);
  });

  it('does not flag very short transcripts (handled by the length guard upstream)', () => {
    expect(looksLikeNarrationEcho('the cat', STORY)).toBe(false);
  });

  it('returns false when there is no story yet', () => {
    expect(looksLikeNarrationEcho('Pemberley the cat began her patrol', '')).toBe(false);
  });
});

describe('looksLikeMicCheck', () => {
  it('recognizes greeting and mic-check turns that should wait for a follow-up', () => {
    expect(looksLikeMicCheck('Can you hear me?')).toBe(true);
    expect(looksLikeMicCheck('hello')).toBe(true);
    expect(looksLikeMicCheck('Hello. Hello. Hello.')).toBe(true);
    expect(looksLikeMicCheck('Are you there?')).toBe(true);
  });

  it('does not classify story questions as mic checks', () => {
    expect(looksLikeMicCheck("What is the cat's name?")).toBe(false);
    expect(looksLikeMicCheck('How does the story end?')).toBe(false);
  });
});

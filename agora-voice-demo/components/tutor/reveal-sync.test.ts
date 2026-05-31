import { describe, it, expect } from 'vitest';
import { revealedTokenCount } from './reveal-sync';
import { tokenize } from './theme';

const SCENE = 'Young Albert sat on a grassy hill watching the clouds';

describe('revealedTokenCount — audio-synced word reveal', () => {
  it('nothing spoken yet → reveal nothing', () => {
    expect(revealedTokenCount(SCENE, '')).toBe(0);
    expect(revealedTokenCount(SCENE, '   ')).toBe(0);
  });

  it('partial spoken prefix reveals exactly that many words (2 tokens/word)', () => {
    // 3 words spoken → 6 tokens (word+space pairs).
    expect(revealedTokenCount(SCENE, 'Young Albert sat')).toBe(6);
    // 1 word → 2 tokens.
    expect(revealedTokenCount(SCENE, 'Young')).toBe(2);
  });

  it('ignores case + trailing punctuation when aligning', () => {
    expect(revealedTokenCount('Light travels fast.', 'light TRAVELS')).toBe(4);
  });

  it('full scene spoken → reveal all tokens (capped)', () => {
    const all = tokenize(SCENE).length;
    expect(revealedTokenCount(SCENE, SCENE)).toBe(all);
    // Over-spoken (transcript ran past) still caps at scene length.
    expect(revealedTokenCount(SCENE, SCENE + ' and more words')).toBe(all);
  });

  it('returns -1 when the transcript is a DIFFERENT scene (caller falls back)', () => {
    expect(revealedTokenCount(SCENE, 'The fox crept out from behind a tree')).toBe(-1);
  });

  it('returns -1 on a coincidental single-word match mid-utterance', () => {
    // "Young" matches word 0, but the rest diverges and the speaker is 3+ words
    // in → not this scene.
    expect(revealedTokenCount(SCENE, 'Young readers love stories')).toBe(-1);
  });

  it('reveals up to the matched prefix even if the transcript later diverges', () => {
    // First two words match, third diverges → reveal 2 words (4 tokens).
    expect(revealedTokenCount(SCENE, 'Young Albert quietly')).toBe(4);
  });

  it('empty narration → 0', () => {
    expect(revealedTokenCount('', 'anything')).toBe(0);
  });
});

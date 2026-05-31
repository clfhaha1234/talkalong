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

import { matchSceneIndex } from './reveal-sync';

describe('matchSceneIndex — which scene is the audio on', () => {
  const SCENES = [
    'Young Albert sat on a grassy hill watching the clouds.',
    'Years later he imagined a train racing as fast as light.',
    'He discovered that time can stretch like a rubber band.',
  ];

  it('matches the scene the spoken text aligns to', () => {
    expect(matchSceneIndex(SCENES, 'Young Albert sat on')).toBe(0);
    expect(matchSceneIndex(SCENES, 'Years later he imagined')).toBe(1);
    expect(matchSceneIndex(SCENES, 'He discovered that time')).toBe(2);
  });

  it('returns -1 when nothing aligns (silence / bridge / QA answer)', () => {
    expect(matchSceneIndex(SCENES, '')).toBe(-1);
    expect(matchSceneIndex(SCENES, 'Let me tell you a different unrelated thing')).toBe(-1);
  });

  it('picks the longest-aligned scene when a short prefix is ambiguous', () => {
    const scenes = ['The fox ran home.', 'The fox ran home through the silver forest at night.'];
    // Both start "The fox ran home", but the 2nd aligns further.
    expect(matchSceneIndex(scenes, 'The fox ran home through the silver')).toBe(1);
  });
});

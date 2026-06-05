import { describe, expect, it } from 'vitest';
import { applyRescriptUpdates, hasUsableAudioDataUrl } from './rescriptUpdates';

describe('applyRescriptUpdates', () => {
  const original = [
    { id: 's1', narration: 'The cat slept on a shelf.', audioDataUrl: 'data:audio/mp3;base64,english-one' },
    { id: 's2', narration: 'The mouse opened a map.', audioDataUrl: 'data:audio/mp3;base64,english-two' },
  ];

  it('updates narration and audio together', () => {
    const audio = `data:audio/mp3;base64,${'x'.repeat(160)}`;
    const next = applyRescriptUpdates(original, [
      { id: 's2', narration: '小老鼠打开了一张地图。', audioDataUrl: audio },
    ]);

    expect(next?.[1]).toMatchObject({
      id: 's2',
      narration: '小老鼠打开了一张地图。',
      audioDataUrl: audio,
    });
  });

  it('rejects rewrites with missing audio instead of mixing new subtitles with old speech', () => {
    const next = applyRescriptUpdates(original, [
      { id: 's2', narration: '小老鼠打开了一张地图。', audioDataUrl: '' },
    ]);

    expect(next).toBeNull();
  });
});

describe('hasUsableAudioDataUrl', () => {
  it('requires a real audio data URL', () => {
    expect(hasUsableAudioDataUrl(`data:audio/mp3;base64,${'x'.repeat(160)}`)).toBe(true);
    expect(hasUsableAudioDataUrl('')).toBe(false);
    expect(hasUsableAudioDataUrl('https://example.com/audio.mp3')).toBe(false);
  });
});

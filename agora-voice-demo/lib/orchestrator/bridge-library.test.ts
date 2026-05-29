import { describe, it, expect } from 'vitest';
import { BRIDGES, pickBridge } from './bridge-library';

describe('bridge library', () => {
  it('has at least 10 entries', () => {
    expect(BRIDGES.length).toBeGreaterThanOrEqual(10);
  });
  it('entries are 4-6 second utterances (rough: 60-180 chars)', () => {
    for (const b of BRIDGES) {
      expect(b.length).toBeGreaterThanOrEqual(60);
      expect(b.length).toBeLessThanOrEqual(180);
    }
  });
  it('pickBridge returns one of the entries', () => {
    const b = pickBridge();
    expect(BRIDGES).toContain(b);
  });
  it('pickBridge gives variety over multiple calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) seen.add(pickBridge());
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

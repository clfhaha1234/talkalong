import { describe, it, expect } from 'vitest';
import { ComprehensionTracker } from './comprehension-tracker';

describe('comprehension tracker', () => {
  it('starts at default', () => {
    const t = new ComprehensionTracker();
    expect(t.signal().depth_setting).toBe('default');
  });

  it('many correct elicitations → deeper', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 3; i++) t.onElicitation(true);
    expect(t.signal().depth_setting).toBe('deeper');
  });

  it('mostly wrong / silent → simpler', () => {
    const t = new ComprehensionTracker();
    t.onElicitation(false);
    t.onElicitation(false);
    t.onElicitation(false);
    expect(t.signal().depth_setting).toBe('simpler');
  });

  it('high QA depth signals confusion → simpler', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 5; i++) t.onQaTurn();
    expect(t.signal().depth_setting).toBe('simpler');
  });

  it('flips at most once per session for demo simplicity', () => {
    const t = new ComprehensionTracker();
    for (let i = 0; i < 3; i++) t.onElicitation(true);
    expect(t.signal().depth_setting).toBe('deeper');
    for (let i = 0; i < 5; i++) t.onQaTurn();
    // Already flipped to deeper; second flip is suppressed
    expect(t.signal().depth_setting).toBe('deeper');
  });
});

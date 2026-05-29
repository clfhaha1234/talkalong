import { describe, it, expect } from 'vitest';
import { isElicit, type AgendaSegment } from './types';

describe('AgendaSegment', () => {
  it('discriminates deliver vs elicit', () => {
    const d: AgendaSegment = { id: 's1', kind: 'deliver', text: 'Once upon a time.' };
    const e: AgendaSegment = { id: 'q1', kind: 'elicit', question: 'Why did you apply?', target: 'a concrete motivation', load_bearing: true };
    expect(isElicit(d)).toBe(false);
    expect(isElicit(e)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { isBackChannelOnly } from './back-channel';

const u = (text: string) => ({ role: 'user' as const, text });
const a = (text: string) => ({ role: 'agent' as const, text });

describe('isBackChannelOnly', () => {
  it('flags pure acknowledgements (resume without a bridge)', () => {
    for (const w of ['okay', 'Okay.', 'yeah', 'uh huh', 'mm', 'right', 'got it', 'sure', 'OK cool!', 'alright']) {
      expect(isBackChannelOnly([u(w)]), w).toBe(true);
    }
  });

  it('does NOT flag real questions (planner must run)', () => {
    for (const q of [
      'why?', 'what does that mean?', 'how fast does light travel?',
      'who is she?', 'can you say that in Chinese?', 'wait, what was the cat called?',
      'no, I meant the other one', 'tell me more about the train',
    ]) {
      expect(isBackChannelOnly([u(q)]), q).toBe(false);
    }
  });

  it('ignores agent turns; judges only the user side', () => {
    expect(isBackChannelOnly([u('okay'), a('Glad that helps — listen on.')])).toBe(true);
    expect(isBackChannelOnly([a('The cat is Pemberley.'), u('why is she magic?')])).toBe(false);
  });

  it('flags multi-token all-back-channel utterances but not mixed ones', () => {
    expect(isBackChannelOnly([u('okay yeah')])).toBe(true);
    expect(isBackChannelOnly([u('okay but why')])).toBe(false);
  });

  it('returns false for empty / agent-only histories (no-question guard owns those)', () => {
    expect(isBackChannelOnly([])).toBe(false);
    expect(isBackChannelOnly([a('narration tail')])).toBe(false);
    expect(isBackChannelOnly([u('   ')])).toBe(false);
  });

  it('treats every user turn — all must be back-channel', () => {
    expect(isBackChannelOnly([u('okay'), u('yeah')])).toBe(true);
    expect(isBackChannelOnly([u('okay'), u('why though?')])).toBe(false);
  });
});

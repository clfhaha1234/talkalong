// Unit tests for the language detector used by composeLessonAsync.
//
// Locks the heuristic so future tweaks don't silently regress a known input.
// The acceptance criterion the user surfaced 2026-05-30:
// "分享一个猫的故事" (Chinese) must yield a Chinese story, not English.
// Story language follows TTS voice + STT language + agent persona via the
// shared lib/language-config.ts selectors, so misclassification here breaks
// every downstream audio path.
import { describe, it, expect } from 'vitest';
import { detectLanguage } from './script-generator';

describe('detectLanguage', () => {
  // ── the failing case from the bug report ───────────────────────────────
  it('Chinese topic → zh (the bug that triggered this work)', () => {
    expect(detectLanguage('分享一个猫的故事').code).toBe('zh');
  });
  it('Chinese mixed with punctuation → zh', () => {
    expect(detectLanguage('讲一个关于小猫和星空的故事，给五岁的孩子听').code).toBe('zh');
  });
  it('Chinese with embedded English term → zh (CJK dominates)', () => {
    expect(detectLanguage('讲一个 Newton 发现万有引力的故事').code).toBe('zh');
  });

  // ── other CJK ──────────────────────────────────────────────────────────
  it('Japanese with hiragana → ja (beats generic CJK)', () => {
    expect(detectLanguage('猫の物語を聞かせてください').code).toBe('ja');
  });
  it('Japanese katakana-only → ja', () => {
    expect(detectLanguage('ネコノオハナシヲキカセテ').code).toBe('ja');
  });
  it('Korean hangul → ko', () => {
    expect(detectLanguage('고양이 이야기를 들려주세요').code).toBe('ko');
  });

  // ── other scripts ──────────────────────────────────────────────────────
  it('Arabic → ar', () => {
    expect(detectLanguage('احكِ لي قصة عن قطة').code).toBe('ar');
  });
  it('Russian Cyrillic → ru', () => {
    expect(detectLanguage('Расскажи историю про кота').code).toBe('ru');
  });

  // ── Latin-script European ──────────────────────────────────────────────
  it('Spanish keywords → es', () => {
    expect(detectLanguage('Cuéntame el cuento del niño y el gato').code).toBe('es');
  });
  it('French accents → fr', () => {
    expect(detectLanguage("Raconte-moi l'histoire d'un enfant et de son chat").code).toBe('fr');
  });
  it('German keywords → de', () => {
    expect(detectLanguage('Erzähl mir die Geschichte vom Kind und der Katze').code).toBe('de');
  });

  // ── default fallback ───────────────────────────────────────────────────
  it('English fallback when no signals match', () => {
    expect(detectLanguage('Tell me a story about a cat').code).toBe('en');
  });
  it('Single English word → en', () => {
    expect(detectLanguage('cats').code).toBe('en');
  });
  it('Empty input → en (defensive)', () => {
    expect(detectLanguage('').code).toBe('en');
  });

  // ── shape: every return carries code + name ────────────────────────────
  it('always returns {code, name}', () => {
    const result = detectLanguage('分享一个猫的故事');
    expect(result).toHaveProperty('code');
    expect(result).toHaveProperty('name');
    expect(typeof result.name).toBe('string');
    expect(result.name.length).toBeGreaterThan(0);
  });
});

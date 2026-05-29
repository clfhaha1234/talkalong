// Input stage of the storybook flow — ports prototype-screens.jsx:16-110 to
// React 19 + TypeScript. Renders the brand mark, italic headline, soft-card
// textarea, Begin button, and 3 preset chips. Preset clicks call onBegin with
// the prefill text, matching the prototype's "click chip → auto-submit"
// behavior.

'use client';

import { useState } from 'react';
import { T, F_HEAD, F_BODY } from './theme';

// Verbatim prototype PRESETS — we surface only the first 3 in the UI but keep
// the full list for parity / future preset slots.
export const PRESETS: ReadonlyArray<{ title: string; sub: string; prefill: string }> = [
  {
    title: "Einstein's Relativity",
    sub: 'why time stretches when you run',
    prefill:
      "Tell me the story of Einstein's special relativity — how he figured out that time can stretch and bend. Aim it at a curious 10-year-old.",
  },
  {
    title: 'Why we have seasons',
    sub: 'a tilted earth, a year of light',
    prefill:
      "Explain to a 9-year-old why the earth has seasons. Use the idea of the tilt of the earth's axis.",
  },
  {
    title: 'Photosynthesis',
    sub: 'how a leaf eats sunlight',
    prefill:
      'Tell me the story of photosynthesis as if a leaf were telling it to a curious kid. Include sunlight, water, CO₂ and sugar.',
  },
  {
    title: 'The Little Prince · Ch. 4',
    sub: 'a sad chapter about numbers',
    prefill:
      "Read me Chapter 4 of The Little Prince — the one about grown-ups and numbers. Tell it slowly, like a bedtime story.",
  },
  {
    title: 'The Black Death',
    sub: 'a plague that changed Europe',
    prefill:
      'Tell me how the Black Death changed medieval Europe, and how it eventually helped lead to the Renaissance.',
  },
];

interface InputScreenProps {
  /** Called when the user hits Begin or a preset chip. The argument is the
   *  exact text the storybook backend will receive as input_text. */
  onBegin: (text: string) => void;
  /** Optional initial text — used to repopulate the field on stage="error". */
  initialText?: string;
  /** Set true while the parent is awaiting the SSE connection. We don't fade
   *  here since the parent switches the whole stage to LoadingScreen, but we
   *  still gate clicks to prevent double-submits in the brief gap. */
  disabled?: boolean;
}

export function InputScreen({
  onBegin,
  initialText = '',
  disabled = false,
}: InputScreenProps) {
  const [text, setText] = useState(initialText);

  const handleBegin = (override?: string) => {
    if (disabled) return;
    const payload = (override ?? text ?? '').trim();
    if (!payload) {
      // Fall back to first preset prefill — mirrors prototype behavior.
      onBegin(PRESETS[0].prefill);
      return;
    }
    onBegin(payload);
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: T.paper,
        color: T.ink,
        fontFamily: F_BODY,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: T.paperTexture,
          pointerEvents: 'none',
        }}
      />

      {/* Tiny brand top-left */}
      <div
        style={{
          position: 'absolute',
          top: 32,
          left: 40,
          fontSize: 11,
          letterSpacing: '0.35em',
          color: T.inkSoft,
          textTransform: 'uppercase',
        }}
      >
        The · AI · Teacher
      </div>

      <div
        style={{
          maxWidth: 640,
          margin: '0 auto',
          padding: '180px 40px 60px',
          position: 'relative',
          textAlign: 'center',
        }}
      >
        {/* Headline */}
        <h1
          style={{
            fontFamily: F_HEAD,
            fontWeight: 500,
            fontStyle: 'italic',
            fontSize: 56,
            lineHeight: 1.1,
            margin: 0,
            letterSpacing: '-0.005em',
          }}
        >
          What shall we{' '}
          <span style={{ color: T.rose }}>
            <em>learn</em>
          </span>{' '}
          tonight?
        </h1>

        {/* Input — soft card, no tabs */}
        <div
          style={{
            marginTop: 40,
            textAlign: 'left',
            position: 'relative',
            background: T.paperHi,
            border: `1px solid ${T.paperEdge}`,
            borderRadius: 4,
            padding: '18px 20px 12px',
            boxShadow: '0 8px 24px rgba(60,40,20,0.05)',
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a paper, or type a topic…"
            disabled={disabled}
            style={{
              display: 'block',
              width: '100%',
              minHeight: 100,
              border: 'none',
              resize: 'none',
              background: 'transparent',
              color: T.ink,
              fontFamily: F_HEAD,
              fontSize: 21,
              lineHeight: 1.5,
              outline: 'none',
              fontStyle: text ? 'normal' : 'italic',
              padding: 0,
            }}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 10,
              paddingTop: 10,
              borderTop: `1px solid ${T.paperEdge}`,
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: T.inkWhisper,
                fontFamily: F_HEAD,
                fontStyle: 'italic',
              }}
            >
              · a sentence or a whole paper — both work
            </div>
            <button
              type="button"
              onClick={() => handleBegin()}
              disabled={disabled}
              style={{
                background: T.ink,
                color: T.paper,
                border: 'none',
                padding: '10px 22px',
                fontFamily: F_HEAD,
                fontStyle: 'italic',
                fontSize: 16,
                cursor: disabled ? 'wait' : 'pointer',
                letterSpacing: '0.04em',
                borderRadius: 2,
                opacity: disabled ? 0.7 : 1,
              }}
            >
              Begin  →
            </button>
          </div>
        </div>

        {/* Preset chips — only the first 3 */}
        <div
          style={{
            marginTop: 36,
            display: 'flex',
            gap: 8,
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: T.inkSoft,
              fontFamily: F_HEAD,
              fontStyle: 'italic',
              alignSelf: 'center',
              marginRight: 4,
            }}
          >
            or try:
          </span>
          {PRESETS.slice(0, 3).map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleBegin(p.prefill)}
              disabled={disabled}
              style={{
                background: 'transparent',
                cursor: disabled ? 'wait' : 'pointer',
                border: `1px solid ${T.paperEdge}`,
                borderRadius: 999,
                padding: '6px 14px',
                fontFamily: F_HEAD,
                fontStyle: 'italic',
                fontSize: 14,
                color: T.ink,
                letterSpacing: '0.01em',
                opacity: disabled ? 0.7 : 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = T.rose;
                e.currentTarget.style.color = T.rose;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = T.paperEdge;
                e.currentTarget.style.color = T.ink;
              }}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

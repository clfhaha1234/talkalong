// AI Teacher — interactive prototype (Classic Storybook direction, English).
// State machine: input → loading → story (auto-paging) with mic interrupt → QA → resume.

const { useEffect, useState, useRef, useMemo, useCallback } = React;

// Theme (carried from Variant A)
const T = {
  paper: '#F6EFE0',
  paperEdge: '#EFE6D2',
  paperHi: '#FCF7E8',
  ink: '#3B2A1A',
  inkSoft: '#6B5742',
  inkWhisper: '#998873',
  rose: '#C77B6A',
  sage: '#8B9D7E',
  gold: '#C49A4B',
  paperTexture: 'radial-gradient(ellipse at center, transparent 40%, rgba(60,40,20,0.06) 100%)',
};
const F_HEAD = '"EB Garamond", "Cormorant Garamond", serif';
const F_BODY = '"EB Garamond", serif';
const F_MONO = '"JetBrains Mono", ui-monospace, monospace';

// ──────────────────────────────────────────────────────────────
// Scene data
const SCENES = [
  {
    chapter: 'Chapter One',
    sceneNum: 'Scene I',
    headline: ['A curious question', 'about time.'],
    Illustration: () => <window.StoryTitleIllustration animate={true} />,
    narration:
      "Once upon a time, a quiet young man named Albert asked a strange question. " +
      "What if time isn't the same for everyone? " +
      "What if your clock and my clock could quietly, secretly, disagree?",
  },
  {
    chapter: 'Chapter Two',
    sceneNum: 'Scene II',
    headline: ['Two friends,', 'two clocks.'],
    Illustration: () => <window.RelativityIllustration palette={window.STORY_PALETTE} animate={true} />,
    narration:
      "Imagine two friends, each holding a perfectly identical clock. " +
      "One stays here on the ground. The other climbs into a spaceship and zooms away — " +
      "faster, and faster, and faster. When she finally returns home, " +
      "the two clocks no longer agree.",
  },
  {
    chapter: 'Chapter Three',
    sceneNum: 'Scene III',
    headline: ['But light is', 'a rule-breaker.'],
    Illustration: () => <window.LightBeamIllustration animate={true} />,
    narration:
      "Here is the strangest part. No matter how fast you chase a beam of light, " +
      "it always slips away from you at exactly the same speed. " +
      "We call that speed c. Always c. Never faster, never slower.",
  },
  {
    chapter: 'Chapter Four',
    sceneNum: 'Scene IV',
    headline: ['So time itself', 'must stretch.'],
    Illustration: () => <window.SpacetimeStretchIllustration animate={true} />,
    narration:
      "If light refuses to slow down for anyone, then something else has to give. " +
      "Einstein realized what that something was — time itself. " +
      "The faster you move through space, the more slowly you move through time.",
  },
  {
    chapter: 'Chapter Five',
    sceneNum: 'Scene V',
    headline: ['The twin', 'who stays young.'],
    Illustration: () => <window.TwinParadoxIllustration animate={true} />,
    narration:
      "Take a rocket to a faraway star, and then zoom back home — " +
      "and you will arrive a little younger than your twin who stayed behind. " +
      "Astronauts on the space station age more slowly than the rest of us, every single day.",
  },
  {
    chapter: 'Chapter Six',
    sceneNum: 'Finale',
    headline: ['And that', 'was his big idea.'],
    Illustration: () => <window.ClosingIllustration animate={true} />,
    narration:
      "Albert called it relativity. Everything depends on how you are moving. " +
      "Today the GPS in your phone, the satellites above us, even our ideas about black holes — " +
      "all of them rest on this one curious question. Pretty good, don't you think?",
  },
];

// Word-by-word reveal helper
function tokenize(text) {
  return text.split(/(\s+)/);
}

// ──────────────────────────────────────────────────────────────
// Tiny shared bits
function Flourish({ size = 60, color = T.gold }) {
  return (
    <svg width={size} height="14" viewBox="0 0 120 14" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round">
      <path d="M 5 7 q 25 -8 50 0 t 50 0" />
      <circle cx="60" cy="7" r="1.8" fill={color} stroke="none" />
      <circle cx="15" cy="7" r="1" fill={color} stroke="none" />
      <circle cx="105" cy="7" r="1" fill={color} stroke="none" />
    </svg>
  );
}

function CornerOrn({ pos, color = T.gold, inset = 24 }) {
  const isLeft = pos.includes('l'), isTop = pos.includes('t');
  const transform = `${isLeft ? '' : 'scaleX(-1)'} ${isTop ? '' : 'scaleY(-1)'}`.trim();
  return (
    <svg width="56" height="56" viewBox="0 0 60 60" fill="none"
      style={{
        position: 'absolute',
        top: isTop ? inset : 'auto', bottom: !isTop ? inset : 'auto',
        left: isLeft ? inset : 'auto', right: !isLeft ? inset : 'auto',
        transform, pointerEvents: 'none',
      }}>
      <path d="M 8 8 L 40 8 M 8 8 L 8 40" stroke={color} strokeWidth="1" />
      <path d="M 8 14 q 12 0 20 -6" stroke={color} strokeWidth="0.8" fill="none" />
      <circle cx="14" cy="14" r="2" fill={color} />
    </svg>
  );
}

// Mic icon
function MicIcon({ color, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <rect x="8" y="3" width="6" height="11" rx="3" stroke={color} strokeWidth="1.6" />
      <path d="M 5 11 a 6 6 0 0 0 12 0 M 11 17 L 11 20 M 8 20 L 14 20" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// Pause icon
function PauseIcon({ color, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <rect x="4" y="3" width="3.5" height="12" fill={color} />
      <rect x="10.5" y="3" width="3.5" height="12" fill={color} />
    </svg>
  );
}
function PlayIcon({ color, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M 4 3 L 15 9 L 4 15 Z" fill={color} />
    </svg>
  );
}

// expose
window.PrototypeShared = { T, F_HEAD, F_BODY, F_MONO, Flourish, CornerOrn, MicIcon, PauseIcon, PlayIcon, SCENES, tokenize };

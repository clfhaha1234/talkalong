// SVG ornaments + icons ported from prototype-shared.jsx and prototype-story.jsx.
// Each helper renders the exact SVG paths from the prototype.

import type { CSSProperties } from 'react';
import { T } from './theme';

interface FlourishProps {
  size?: number;
  color?: string;
}

export function Flourish({ size = 60, color = T.gold }: FlourishProps) {
  return (
    <svg
      width={size}
      height="14"
      viewBox="0 0 120 14"
      fill="none"
      stroke={color}
      strokeWidth="1.2"
      strokeLinecap="round"
    >
      <path d="M 5 7 q 25 -8 50 0 t 50 0" />
      <circle cx="60" cy="7" r="1.8" fill={color} stroke="none" />
      <circle cx="15" cy="7" r="1" fill={color} stroke="none" />
      <circle cx="105" cy="7" r="1" fill={color} stroke="none" />
    </svg>
  );
}

interface CornerOrnProps {
  pos: 'tl' | 'tr' | 'bl' | 'br';
  color?: string;
  inset?: number;
}

export function CornerOrn({ pos, color = T.gold, inset = 24 }: CornerOrnProps) {
  const isLeft = pos.includes('l');
  const isTop = pos.includes('t');
  const transform =
    `${isLeft ? '' : 'scaleX(-1)'} ${isTop ? '' : 'scaleY(-1)'}`.trim();
  const style: CSSProperties = {
    position: 'absolute',
    top: isTop ? inset : 'auto',
    bottom: !isTop ? inset : 'auto',
    left: isLeft ? inset : 'auto',
    right: !isLeft ? inset : 'auto',
    transform,
    pointerEvents: 'none',
  };
  return (
    <svg width="56" height="56" viewBox="0 0 60 60" fill="none" style={style}>
      <path d="M 8 8 L 40 8 M 8 8 L 8 40" stroke={color} strokeWidth="1" />
      <path
        d="M 8 14 q 12 0 20 -6"
        stroke={color}
        strokeWidth="0.8"
        fill="none"
      />
      <circle cx="14" cy="14" r="2" fill={color} />
    </svg>
  );
}

interface MicIconProps {
  color: string;
  size?: number;
}

export function MicIcon({ color, size = 22 }: MicIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <rect
        x="8"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke={color}
        strokeWidth="1.6"
      />
      <path
        d="M 5 11 a 6 6 0 0 0 12 0 M 11 17 L 11 20 M 8 20 L 14 20"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface PauseIconProps {
  color: string;
  size?: number;
}

export function PauseIcon({ color, size = 18 }: PauseIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <rect x="4" y="3" width="3.5" height="12" fill={color} />
      <rect x="10.5" y="3" width="3.5" height="12" fill={color} />
    </svg>
  );
}

export function PlayIcon({ color, size = 18 }: PauseIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <path d="M 4 3 L 15 9 L 4 15 Z" fill={color} />
    </svg>
  );
}

// Animated mic waveform — used during BRANCH state on the QA composer.
interface WaveformProps {
  active: boolean;
}

export function Waveform({ active }: WaveformProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 22 }}>
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: '100%',
            background: T.rose,
            borderRadius: 2,
            opacity: 0.8,
            animation: active
              ? `wave ${0.6 + (i % 3) * 0.15}s ease-in-out ${i * 0.08}s infinite`
              : 'none',
            transformOrigin: 'center',
            transform: 'scaleY(0.2)',
          }}
        />
      ))}
      <style>{`@keyframes wave { 0%,100% { transform: scaleY(0.2);} 50% { transform: scaleY(1);} }`}</style>
    </div>
  );
}

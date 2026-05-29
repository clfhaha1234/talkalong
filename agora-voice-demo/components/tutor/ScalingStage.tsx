// Design-canvas scaling stage. Children are rendered inside a 1280×800 box
// that is uniformly scaled to fit the viewport (preserving aspect ratio).
// Ported verbatim from reference/storybook-prototype/The AI Teacher.html:71-95.

'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface ScalingStageProps {
  children: ReactNode;
}

export function ScalingStage({ children }: ScalingStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => {
      const el = stageRef.current;
      if (!el) return;
      const sx = window.innerWidth / 1280;
      const sy = window.innerHeight / 800;
      const s = Math.min(sx, sy);
      el.style.transform = `scale(${s})`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F6EFE0',
      }}
    >
      <div
        ref={stageRef}
        style={{
          position: 'relative',
          width: 1280,
          height: 800,
          flexShrink: 0,
          transformOrigin: 'center center',
          background: '#F6EFE0',
        }}
      >
        {children}
      </div>
    </div>
  );
}

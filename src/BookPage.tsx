import React, { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  delayRender,
  continueRender,
  Easing,
} from 'remotion';
import { mulberry32, shuffle } from './rng';

interface BookPageProps {
  linesSvgPath: string;
  colorImagePath: string;
  seed: number;
  bgColor: string;
}

interface ParsedSvg {
  width: number;
  height: number;
  viewBox: string;
  paths: string[];
}

function parseLinesSvg(svgText: string): ParsedSvg {
  const widthMatch = svgText.match(/<svg[^>]*\swidth="([^"]+)"/);
  const heightMatch = svgText.match(/<svg[^>]*\sheight="([^"]+)"/);
  const viewBoxMatch = svgText.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  const width = widthMatch ? parseFloat(widthMatch[1]) : 1408;
  const height = heightMatch ? parseFloat(heightMatch[1]) : 768;
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${width} ${height}`;
  const paths: string[] = [];
  const re = /<path[^>]*\sd="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgText)) !== null) paths.push(m[1]);
  return { width, height, viewBox, paths };
}

const PHASE = {
  drawStart: 0.0,
  drawEnd: 2.5,
  colorStart: 2.0,
  colorEnd: 4.0,
  breatheStart: 3.0,
};

interface RandomState {
  orderRank: number[]; // for each original path index, its draw-order rank (0 = drawn first)
  jitter: number[];    // per-path start-time jitter in [-0.5, 0.5]
  wiggle: Array<{ phaseX: number; phaseY: number; ampX: number; ampY: number; freqX: number; freqY: number }>;
  kenBurns: {
    endScale: number; // 1.02 .. 1.05
    endX: number;     // ±30 px
    endY: number;     // ±20 px
    breatheAmp: number; // 0.006 .. 0.014
    breatheFreq: number; // 0.5 .. 0.9 (cycles per second)
  };
}

function buildRandomState(seed: number, pathCount: number): RandomState {
  const rng = mulberry32(seed);
  const indices = Array.from({ length: pathCount }, (_, i) => i);
  const drawOrder = shuffle(indices, rng);
  const orderRank = new Array<number>(pathCount);
  drawOrder.forEach((origIdx, rank) => {
    orderRank[origIdx] = rank;
  });
  const jitter = Array.from({ length: pathCount }, () => rng() - 0.5);
  const wiggle = Array.from({ length: pathCount }, () => ({
    phaseX: rng() * Math.PI * 2,
    phaseY: rng() * Math.PI * 2,
    ampX: 0.4 + rng() * 0.7,   // 0.4 .. 1.1 px
    ampY: 0.4 + rng() * 0.7,
    freqX: 0.10 + rng() * 0.10, // 0.10 .. 0.20 rad/frame
    freqY: 0.10 + rng() * 0.10,
  }));
  const kenBurns = {
    endScale: 1.02 + rng() * 0.03,
    endX: (rng() - 0.5) * 60,
    endY: (rng() - 0.5) * 40,
    breatheAmp: 0.006 + rng() * 0.008,
    breatheFreq: 0.5 + rng() * 0.4,
  };
  return { orderRank, jitter, wiggle, kenBurns };
}

export const BookPage: React.FC<BookPageProps> = ({ linesSvgPath, colorImagePath, seed, bgColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const totalSec = durationInFrames / fps;

  const [svgData, setSvgData] = useState<ParsedSvg | null>(null);
  const [handle] = useState(() => delayRender('Loading lines.svg'));

  useEffect(() => {
    fetch(staticFile(linesSvgPath))
      .then((r) => r.text())
      .then((text) => {
        setSvgData(parseLinesSvg(text));
        continueRender(handle);
      })
      .catch((e) => {
        console.error('Failed to load lines SVG', e);
        continueRender(handle);
      });
  }, [linesSvgPath, handle]);

  const rand = useMemo<RandomState | null>(
    () => (svgData ? buildRandomState(seed, svgData.paths.length) : null),
    [svgData, seed],
  );

  if (!svgData || !rand) return null;

  // --- per-path stroke-dashoffset with shuffled order + jitter ---
  const drawStartF = PHASE.drawStart * fps;
  const drawEndF = PHASE.drawEnd * fps;
  const drawSpan = drawEndF - drawStartF;
  const perPathDurationF = Math.max(6, drawSpan / 10);
  const staggerWindow = Math.max(1, drawSpan - perPathDurationF);
  const slotPerPath = staggerWindow / Math.max(1, svgData.paths.length - 1);
  const jitterMagnitude = slotPerPath * 1.8; // ±0.9 of one slot — overlaps neighbors

  const pathElements = svgData.paths.map((d, i) => {
    const rank = rand.orderRank[i];
    const baseStart = drawStartF + rank * slotPerPath;
    const pathStart = baseStart + rand.jitter[i] * jitterMagnitude;
    const localProgress = interpolate(frame, [pathStart, pathStart + perPathDurationF], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    });
    const dashOffset = 1 - localProgress;

    const w = rand.wiggle[i];
    const wx = w.ampX * Math.sin(frame * w.freqX + w.phaseX);
    const wy = w.ampY * Math.cos(frame * w.freqY + w.phaseY);

    return (
      <path
        key={i}
        d={d}
        fill="none"
        stroke="#3a2a20"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={dashOffset}
        transform={`translate(${wx} ${wy})`}
      />
    );
  });

  // --- color reveal ---
  const colorOpacity = interpolate(t, [PHASE.colorStart, PHASE.colorEnd], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
  });
  const colorBlur = interpolate(t, [PHASE.colorStart, PHASE.colorEnd], [8, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic),
  });

  // --- breathing scale (composed with Ken Burns) ---
  const breatheActive = t > PHASE.breatheStart;
  const breatheScale = breatheActive
    ? 1 + rand.kenBurns.breatheAmp * Math.sin((t - PHASE.breatheStart) * rand.kenBurns.breatheFreq * Math.PI)
    : 1;

  // --- Ken Burns: slow drift over the full duration ---
  const kbProgress = interpolate(t, [0, totalSec], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad),
  });
  const kbScale = interpolate(kbProgress, [0, 1], [1.0, rand.kenBurns.endScale]);
  const kbX = interpolate(kbProgress, [0, 1], [0, rand.kenBurns.endX]);
  const kbY = interpolate(kbProgress, [0, 1], [0, rand.kenBurns.endY]);
  const totalScale = kbScale * breatheScale;

  // No end fade-out: each scene is an independent clip that holds on its final
  // frame (full-colour image + Ken Burns end position + continued breathing),
  // and the UI layers a subtle CSS breathe on the held <video>. Fading to the
  // paper bg here would flash the page to near-black between scenes.

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      <AbsoluteFill
        style={{
          transform: `translate(${kbX}px, ${kbY}px) scale(${totalScale})`,
          transformOrigin: 'center center',
        }}
      >
        <AbsoluteFill style={{ opacity: colorOpacity, filter: `blur(${colorBlur}px)` }}>
          <Img
            src={staticFile(colorImagePath)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>

        <AbsoluteFill>
          <svg
            width="100%"
            height="100%"
            viewBox={svgData.viewBox}
            preserveAspectRatio="xMidYMid meet"
          >
            {pathElements}
          </svg>
        </AbsoluteFill>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

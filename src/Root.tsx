import React from 'react';
import { Composition, staticFile } from 'remotion';
import { BookPage } from './BookPage';

const FPS = 18;
const DURATION_SEC = 5;

// Captured once at module load. Each `remotion render` invocation gets a fresh seed,
// but the same seed is propagated to every frame of that render — keeping output
// deterministic across frames yet different across runs. Override via
// `--props='{"seed":12345}'` for reproducible output.
const DEFAULT_SEED = Math.floor(Math.random() * 0x7fffffff);

// Props are now fully parameterized so a single composition can render any
// preprocessed scene. Paths are relative to the Remotion public/ dir
// (resolved via staticFile). The defaults reproduce the original single-image
// `npm run generate` behaviour exactly (reads public/{meta,lines,color}).
interface BookPageInputProps {
  linesSvgPath: string;
  colorImagePath: string;
  metaPath: string;
  seed: number;
  /** Empty string → fall back to meta.json's sampled bgColor. */
  bgColor: string;
}

interface SceneMeta {
  width: number;
  height: number;
  bgColor?: string;
}

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BookPage"
      component={BookPage}
      durationInFrames={DURATION_SEC * FPS}
      fps={FPS}
      // Fallback dimensions; calculateMetadata overrides from the scene's meta.
      width={1408}
      height={768}
      defaultProps={{
        linesSvgPath: 'lines.svg',
        colorImagePath: 'color.png',
        metaPath: 'meta.json',
        seed: DEFAULT_SEED,
        bgColor: '',
      }}
      calculateMetadata={async ({ props }) => {
        // Read the scene's meta at render time so width/height/bgColor track
        // the actual image instead of a compile-time import. fetch(staticFile)
        // works in both `remotion render` (Node) and Studio (browser).
        const res = await fetch(staticFile(props.metaPath));
        const meta = (await res.json()) as SceneMeta;
        return {
          width: meta.width,
          height: meta.height,
          fps: FPS,
          durationInFrames: DURATION_SEC * FPS,
          props: {
            ...props,
            bgColor: props.bgColor || meta.bgColor || '#e5b89a',
          },
        };
      }}
    />
  );
};

export type { BookPageInputProps };

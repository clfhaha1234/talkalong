'use client';

// DEV/TEST-ONLY preview of StoryScreen with canned fixtures — NO Agora, NO API,
// NO mic. It mounts StoryScreen inside the exact same ScalingStage wrapper the
// real /tutor uses (components/TutorPage.tsx), so the CSS `transform: scale()`
// environment — where the feed-scroll / chapter-pin / composer-visibility bugs
// lived — is faithfully reproduced in a real browser.
//
// This is what the Tier-2 Playwright smoke (scripts/e2e/tutor-storyscreen-smoke.mjs)
// drives: real-browser LAYOUT assertions (composer in viewport, feed scrollable)
// that jsdom (Tier 1) structurally cannot make because it has no layout engine.
//
// Renders a fixed, representative "reading" state (mid-story, scene iii, with a
// prior Q&A in the feed). Kept hook-free so there's no client-only state to
// cause a hydration mismatch (which would surface as a console error and fail
// the smoke's no-error check).

import { ScalingStage } from '@/components/tutor/ScalingStage';
import { StoryScreen } from '@/components/tutor/StoryScreen';
import type { Scene } from '@/components/tutor/theme';

const SCENES: Scene[] = [
  {
    id: 's1',
    chapter: 'Chapter One',
    sceneNum: 'i',
    headline: ['The Slow', 'Clock'],
    narration_text:
      'Albert noticed the great clock tower seemed to tick more slowly as his tram sped away from it, faster and faster down the hill.',
    image_prompt: 'a boy watching a clock tower from a speeding tram',
  },
  {
    id: 's2',
    chapter: 'Chapter Two',
    sceneNum: 'ii',
    headline: ['Light', 'Stays'],
    narration_text:
      'No matter how fast he ran, the beam of the lantern always fled ahead of him at exactly the same speed — never faster, never slower.',
    image_prompt: 'a boy chasing a beam of lantern light',
  },
  {
    id: 's3',
    chapter: 'Chapter Three',
    sceneNum: 'iii',
    headline: ['Time', 'Bends'],
    narration_text:
      'And so Albert wondered: if light will not change its speed for anyone, then perhaps it is time itself that must bend to keep the rule.',
    image_prompt: 'clocks melting around a thoughtful boy',
  },
];

const noop = () => {};

export default function StoryScreenPreviewPage() {
  return (
    <ScalingStage>
      <div style={{ position: 'absolute', inset: 0 }}>
        <StoryScreen
          scenes={SCENES}
          activeSceneIndex={2}
          inBranch={false}
          finished={false}
          liveNarrationText={SCENES[2].narration_text}
          liveUserText={null}
          qaHistoryByScene={{
            0: [
              {
                q: 'How fast does light actually travel?',
                a: 'About 300,000 kilometres every second — fast enough to circle the Earth seven times in a blink.',
              },
            ],
          }}
          micDenied={false}
          micMuted={false}
          micLevel={0}
          agentState="speaking"
          onToggleMic={noop}
          onTextQuestion={noop}
          onExit={noop}
        />
      </div>
    </ScalingStage>
  );
}

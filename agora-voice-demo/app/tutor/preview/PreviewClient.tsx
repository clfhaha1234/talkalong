'use client';

// Client half of the dev/test-only StoryScreen preview. Takes a serializable
// `variant` string (chosen by the server page from ?variant=) and maps it to a
// full StoryScreen prop set, supplying the no-op handlers here (functions can't
// cross the server→client boundary, so they must originate in this client
// component). No Agora / API / mic.

import { ScalingStage } from '@/components/tutor/ScalingStage';
import { StoryScreen } from '@/components/tutor/StoryScreen';
import type { Scene } from '@/components/tutor/theme';
import { useState } from 'react';

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

type QaFixture = Record<number, Array<{ q: string; a: string }>>;

const QA: QaFixture = {
  0: [
    {
      q: 'How fast does light actually travel?',
      a: 'About 300,000 kilometres every second — fast enough to circle the Earth seven times in a blink.',
    },
  ],
};

export type PreviewVariant =
  | 'reading'
  | 'muted'
  | 'listening'
  | 'paused'
  | 'finished'
  | 'broken-image';

// Each variant pins the StoryScreen props that exercise a distinct phase/state.
const VARIANTS: Record<PreviewVariant, Record<string, unknown>> = {
  reading: { inBranch: false, agentState: 'speaking', micMuted: false, micLevel: 0, liveUserText: null, finished: false },
  muted: { inBranch: false, agentState: 'speaking', micMuted: true, micLevel: 0, liveUserText: null, finished: false },
  listening: {
    inBranch: true,
    agentState: 'listening',
    micMuted: false,
    micLevel: 0.6,
    liveUserText: 'what is light actually made of',
    finished: false,
  },
  paused: { inBranch: true, agentState: 'idle', micMuted: false, micLevel: 0, liveUserText: null, finished: false },
  finished: { inBranch: true, agentState: 'idle', micMuted: false, micLevel: 0, liveUserText: null, finished: true },
  'broken-image': { inBranch: false, agentState: 'speaking', micMuted: false, micLevel: 0, liveUserText: null, finished: false },
};

const noop = () => {};

function previewAnswer(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('clock') || q.includes('time')) {
    return 'Albert noticed the clock seemed slower because motion changes how time is measured.';
  }
  if (q.includes('light')) {
    return 'Light travels at the same speed for everyone, which is why Albert starts wondering about time.';
  }
  return 'Good question — this preview records the interrupt and shows where the tutor answer would appear.';
}

export function PreviewClient({ variant }: { variant: PreviewVariant }) {
  const v = VARIANTS[variant] ?? VARIANTS.reading;
  const [previewQa, setPreviewQa] = useState(QA);
  const scenes =
    variant === 'broken-image'
      ? SCENES.map((scene, idx) =>
          idx === 2 ? { ...scene, image_url: '/lesson-cache/definitely-missing-field-regression.jpg' } : scene,
        )
      : SCENES;
  return (
    <ScalingStage>
      <div style={{ position: 'absolute', inset: 0 }}>
        <StoryScreen
          scenes={scenes}
          activeSceneIndex={2}
          inBranch={v.inBranch as boolean}
          finished={v.finished as boolean}
          liveNarrationText={scenes[2].narration_text}
          liveUserText={v.liveUserText as string | null}
          qaHistoryByScene={previewQa}
          micDenied={false}
          micMuted={v.micMuted as boolean}
          micLevel={v.micLevel as number}
          agentState={v.agentState as string}
          onToggleMic={noop}
          onTextQuestion={(question) => {
            setPreviewQa((prev) => {
              const sceneQa = prev[2] ?? [];
              return {
                ...prev,
                2: [...sceneQa, { q: question, a: previewAnswer(question) }],
              };
            });
          }}
          onExit={noop}
        />
      </div>
    </ScalingStage>
  );
}

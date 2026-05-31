// Component-render regression tests for StoryScreen — the FIRST automated
// coverage of the live-UI layer where almost every hand-found bug lived
// (composer invisible, feed not rendering, the voice/keyboard toggle, the
// "字幕出现2次" duplicate live bubble). StoryScreen is pure props-driven, so we
// can mount it with fixture props in jsdom and assert the rendered markup
// WITHOUT an Agora session, API credits, or a real mic.
//
// Each test maps to a bug class that previously could only be caught by the
// user manually testing in the browser:
//   - toggle: left=voice / right=keyboard, switching reveals the right composer
//   - composer always docked + visible (the "composer invisible" layout bug)
//   - feed renders one teacher bubble per narrated scene
//   - no duplicate live user bubble when liveUserText is null (字幕出现2次)
//   - typed question is wired to onTextQuestion

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StoryScreen } from './StoryScreen';
import type { Scene } from './theme';

const SCENES: Scene[] = [
  {
    id: 's1',
    chapter: 'Chapter One',
    sceneNum: 'i',
    headline: ['The Slow', 'Clock'],
    narration_text: 'Albert noticed the clock tower ticked slower as the tram sped away.',
    image_prompt: 'a boy watching a clock tower from a tram',
  },
  {
    id: 's2',
    chapter: 'Chapter Two',
    sceneNum: 'ii',
    headline: ['Light', 'Stays'],
    narration_text: 'No matter how fast he ran, the beam of light always fled at the same speed.',
    image_prompt: 'a boy chasing a beam of light',
  },
];

// Minimal valid props; individual tests override what they exercise.
function baseProps(over: Partial<React.ComponentProps<typeof StoryScreen>> = {}) {
  return {
    scenes: SCENES,
    activeSceneIndex: 0,
    inBranch: false,
    finished: false,
    liveNarrationText: null,
    liveUserText: null,
    qaHistoryByScene: {},
    micDenied: false,
    micMuted: false,
    micLevel: 0,
    agentState: 'speaking',
    onToggleMic: vi.fn(),
    onTextQuestion: vi.fn(),
    onExit: vi.fn(),
    ...over,
  } satisfies React.ComponentProps<typeof StoryScreen>;
}

describe('StoryScreen — composer (always docked + visible)', () => {
  it('renders the always-on voice composer by default (not hidden)', () => {
    render(<StoryScreen {...baseProps()} />);
    // The "composer invisible" bug: the always-on listening affordance must be
    // present in the default (voice, unmuted, not-listening) state.
    expect(screen.getByText(/just speak to interrupt/i)).toBeInTheDocument();
  });

  it('shows the muted affordance when micMuted', () => {
    render(<StoryScreen {...baseProps({ micMuted: true })} />);
    // The clickable composer button (distinct from the footer hint line, which
    // also mentions "tap to talk").
    expect(screen.getByRole('button', { name: /muted.*tap to talk/i })).toBeInTheDocument();
  });
});

describe('StoryScreen — voice/keyboard toggle (left=voice, right=keyboard)', () => {
  it('exposes exactly a Voice and a Keyboard segmented control', () => {
    render(<StoryScreen {...baseProps()} />);
    expect(screen.getByTitle('Voice')).toBeInTheDocument();
    expect(screen.getByTitle('Keyboard')).toBeInTheDocument();
  });

  it('defaults to voice mode — no text input shown', () => {
    render(<StoryScreen {...baseProps()} />);
    expect(screen.queryByPlaceholderText(/type|ask|question/i)).not.toBeInTheDocument();
    expect(screen.getByText(/just speak to interrupt/i)).toBeInTheDocument();
  });

  it('clicking Keyboard switches to text mode (text input appears, voice bar gone)', () => {
    render(<StoryScreen {...baseProps()} />);
    fireEvent.click(screen.getByTitle('Keyboard'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByText(/just speak to interrupt/i)).not.toBeInTheDocument();
  });

  it('clicking Voice switches back to voice mode', () => {
    render(<StoryScreen {...baseProps()} />);
    fireEvent.click(screen.getByTitle('Keyboard'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Voice'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText(/just speak to interrupt/i)).toBeInTheDocument();
  });
});

describe('StoryScreen — typed question wiring', () => {
  it('submitting a typed question calls onTextQuestion with the text', () => {
    const onTextQuestion = vi.fn();
    render(<StoryScreen {...baseProps({ onTextQuestion })} />);
    fireEvent.click(screen.getByTitle('Keyboard'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Why does time slow down?' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onTextQuestion).toHaveBeenCalledWith('Why does time slow down?');
  });
});

describe('StoryScreen — feed renders narrated scenes', () => {
  it('renders the first scene narration as a teacher bubble', () => {
    render(<StoryScreen {...baseProps({ activeSceneIndex: 0 })} />);
    expect(
      screen.getByText(/the clock tower ticked slower/i),
    ).toBeInTheDocument();
  });

  it('does not reveal a later scene before the audio reaches it', () => {
    // activeSceneIndex 0 and no liveNarrationText matching scene 2 → scene 2's
    // narration must NOT be in the feed yet (page can't run ahead of the voice).
    render(<StoryScreen {...baseProps({ activeSceneIndex: 0 })} />);
    expect(screen.queryByText(/the beam of light always fled/i)).not.toBeInTheDocument();
  });
});

describe('StoryScreen — no duplicate live user bubble (字幕出现2次 regression)', () => {
  it('shows the live user bubble while a question is in progress', () => {
    render(<StoryScreen {...baseProps({ inBranch: true, liveUserText: 'what is light made of' })} />);
    expect(screen.getByText(/what is light made of/i)).toBeInTheDocument();
  });

  it('renders a committed QA question exactly once (not also as a live bubble)', () => {
    // The bug: a finalised question echoed as BOTH a committed bubble and the
    // live bubble. With liveUserText=null (finalised), the committed question
    // from qaHistoryByScene must appear exactly once.
    render(
      <StoryScreen
        {...baseProps({
          activeSceneIndex: 0,
          liveUserText: null,
          qaHistoryByScene: { 0: [{ q: 'How fast is light?', a: 'About 300,000 km/s.' }] },
        })}
      />,
    );
    const matches = screen.getAllByText(/how fast is light\?/i);
    expect(matches).toHaveLength(1);
  });
});

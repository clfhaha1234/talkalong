// Component-render regression tests for LoadingScreen — the loading stage that
// translates raw SSE progress (script_drafted / scenes_composed / image_ready /
// all_images_ready / video_ready) into the five-step "preparing tonight's
// lesson" UI. The step-derivation logic (deriveSteps) is the bug-prone part:
// which step is active/done, the per-image "n/total" counter, the overall
// progress %, and the final READY hand-off. LoadingScreen is pure props-driven,
// so we mount it with fixture LoadingState in jsdom and assert the markup.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingScreen, type LoadingState } from './LoadingScreen';

// Minimal initial state: SSE stream just opened, nothing observed yet.
function baseState(over: Partial<LoadingState> = {}): LoadingState {
  return {
    scriptDrafted: false,
    scenesComposed: false,
    imagesReady: 0,
    totalScenes: 0,
    allImagesReady: false,
    videosReady: 0,
    ...over,
  };
}

describe('LoadingScreen — chrome (renders for the initial/empty state)', () => {
  it('renders the heading and all five step labels without crashing', () => {
    render(<LoadingScreen state={baseState()} />);
    expect(screen.getByText(/preparing tonight's lesson/i)).toBeInTheDocument();
    expect(screen.getByText('Reading your material')).toBeInTheDocument();
    expect(screen.getByText('Drafting the story script')).toBeInTheDocument();
    expect(screen.getByText('Composing the scenes')).toBeInTheDocument();
    expect(screen.getByText('Sketching each illustration')).toBeInTheDocument();
    expect(screen.getByText('Bringing them to life')).toBeInTheDocument();
  });

  it('initial state: step 0 is active ("in progress …"), nothing is DONE yet', () => {
    render(<LoadingScreen state={baseState()} />);
    // Step 0 is active from the moment the stream opens.
    expect(screen.getByText('in progress …')).toBeInTheDocument();
    // No step has completed.
    expect(screen.queryByText('✓ DONE')).not.toBeInTheDocument();
  });
});

describe('LoadingScreen — progress reflects observed SSE events', () => {
  it('marks step 0 done once scriptDrafted', () => {
    render(<LoadingScreen state={baseState({ scriptDrafted: true })} />);
    // One step (Reading your material) is now done.
    expect(screen.getAllByText('✓ DONE')).toHaveLength(1);
    // Step 1 (Drafting) is now the active one.
    expect(screen.getByText('in progress …')).toBeInTheDocument();
  });

  it('marks steps 0–2 done once scenesComposed (composing fires instantly)', () => {
    render(
      <LoadingScreen
        state={baseState({
          scriptDrafted: true,
          scenesComposed: true,
          totalScenes: 4,
        })}
      />,
    );
    // Reading + Drafting + Composing are all done.
    expect(screen.getAllByText('✓ DONE')).toHaveLength(3);
  });

  it('shows the per-image counter while sketching illustrations', () => {
    render(
      <LoadingScreen
        state={baseState({
          scriptDrafted: true,
          scenesComposed: true,
          totalScenes: 4,
          imagesReady: 2,
        })}
      />,
    );
    // Step 3 active: its progress label is the "n/total …" counter, not the
    // generic "in progress …".
    expect(screen.getByText('2/4 …')).toBeInTheDocument();
    expect(screen.queryByText('in progress …')).not.toBeInTheDocument();
  });

  it('moves to the "rendering …" step once all images are ready', () => {
    render(
      <LoadingScreen
        state={baseState({
          scriptDrafted: true,
          scenesComposed: true,
          totalScenes: 4,
          imagesReady: 4,
          allImagesReady: true,
        })}
      />,
    );
    // Steps 0–3 done; step 4 (Bringing them to life) is active and rendering.
    expect(screen.getAllByText('✓ DONE')).toHaveLength(4);
    expect(screen.getByText('rendering …')).toBeInTheDocument();
  });
});

describe('LoadingScreen — overall progress bar / footer status', () => {
  it('reports a low percentage in the initial state', () => {
    render(<LoadingScreen state={baseState()} />);
    // step 0 active at intraProgress 0.4 → 0.4/5 = 8%.
    expect(screen.getByText(/8% · about a moment more/i)).toBeInTheDocument();
  });

  it('reports a higher percentage as steps complete', () => {
    render(
      <LoadingScreen
        state={baseState({
          scriptDrafted: true,
          scenesComposed: true,
          totalScenes: 4,
          imagesReady: 2,
        })}
      />,
    );
    // 3 done (3.0) + step 3 active at 2/4 (0.5) = 3.5/5 = 70%.
    expect(screen.getByText(/70% · about a moment more/i)).toBeInTheDocument();
  });

  it('shows the READY hand-off once the first video is ready', () => {
    render(
      <LoadingScreen
        state={baseState({
          scriptDrafted: true,
          scenesComposed: true,
          totalScenes: 4,
          imagesReady: 4,
          allImagesReady: true,
          videosReady: 1,
        })}
      />,
    );
    // Every step done; footer flips to the page-turn hand-off line.
    expect(screen.getAllByText('✓ DONE')).toHaveLength(5);
    expect(screen.getByText(/READY · turning the page/i)).toBeInTheDocument();
    expect(screen.queryByText(/about a moment more/i)).not.toBeInTheDocument();
  });
});

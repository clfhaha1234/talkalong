// Component-render regression tests for InputScreen — the entry stage of the
// storybook flow. It's pure props-driven (a textarea, a Begin button, 3 preset
// chips, all wired to onBegin), so we can mount it in jsdom and assert the
// rendered markup + interaction wiring WITHOUT an Agora session or backend.
//
// Behaviors that matter here:
//   - the topic textarea renders and is typeable
//   - the first 3 PRESETS surface as clickable chips
//   - clicking Begin calls onBegin with the typed text (trimmed)
//   - empty Begin falls back to the first preset prefill (prototype parity)
//   - a preset chip auto-submits its prefill
//   - initialText pre-fills the textarea

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputScreen, PRESETS } from './InputScreen';

describe('InputScreen — topic textarea', () => {
  it('renders a typeable topic textarea', () => {
    render(<InputScreen onBegin={vi.fn()} />);
    const input = screen.getByPlaceholderText('Paste a paper, or type a topic…');
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'How do volcanoes work?' } });
    expect(input).toHaveValue('How do volcanoes work?');
  });

  it('pre-fills the textarea from initialText', () => {
    render(<InputScreen onBegin={vi.fn()} initialText="a topic from a prior error" />);
    expect(
      screen.getByPlaceholderText('Paste a paper, or type a topic…'),
    ).toHaveValue('a topic from a prior error');
  });
});

describe('InputScreen — preset chips', () => {
  it('renders the first three preset chips by title', () => {
    render(<InputScreen onBegin={vi.fn()} />);
    expect(screen.getByRole('button', { name: "Einstein's Relativity" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why we have seasons' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photosynthesis' })).toBeInTheDocument();
  });

  it('does not surface presets beyond the first three', () => {
    render(<InputScreen onBegin={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: 'The Little Prince · Ch. 4' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'The Black Death' }),
    ).not.toBeInTheDocument();
  });

  it('clicking a preset chip calls onBegin with that preset prefill', () => {
    const onBegin = vi.fn();
    render(<InputScreen onBegin={onBegin} />);
    fireEvent.click(screen.getByRole('button', { name: 'Photosynthesis' }));
    expect(onBegin).toHaveBeenCalledWith(PRESETS[2].prefill);
  });
});

describe('InputScreen — Begin wiring', () => {
  it('clicking Begin calls onBegin with the typed (trimmed) topic text', () => {
    const onBegin = vi.fn();
    render(<InputScreen onBegin={onBegin} />);
    const input = screen.getByPlaceholderText('Paste a paper, or type a topic…');
    fireEvent.change(input, { target: { value: '  Why is the sky blue?  ' } });
    fireEvent.click(screen.getByRole('button', { name: /begin/i }));
    expect(onBegin).toHaveBeenCalledWith('Why is the sky blue?');
  });

  it('clicking Begin with an empty topic falls back to the first preset prefill', () => {
    const onBegin = vi.fn();
    render(<InputScreen onBegin={onBegin} />);
    fireEvent.click(screen.getByRole('button', { name: /begin/i }));
    expect(onBegin).toHaveBeenCalledWith(PRESETS[0].prefill);
  });

  it('does not call onBegin when disabled', () => {
    const onBegin = vi.fn();
    render(<InputScreen onBegin={onBegin} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /begin/i }));
    expect(onBegin).not.toHaveBeenCalled();
  });
});

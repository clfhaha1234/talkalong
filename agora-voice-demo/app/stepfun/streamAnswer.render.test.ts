import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamAnswer } from './streamAnswer';

function sse(...events: unknown[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      controller.close();
    },
  });
}

function mockStreamResponse(...events: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(sse(...events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  })));
}

function audioEl() {
  const a = document.createElement('audio');
  a.play = vi.fn().mockResolvedValue(undefined);
  a.pause = vi.fn();
  return a;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('MediaSource', undefined);
  URL.createObjectURL = vi.fn(() => 'blob:stepfun-answer');
});

describe('streamAnswer', () => {
  it('plays streamed answer audio and reports question + answer', async () => {
    mockStreamResponse(
      { t: 'meta', question: "What is the cat's name?" },
      { t: 'audio', audio: btoa('fake-mp3-a'), status: 'unfinished' },
      { t: 'answer', answer: "The cat's name is Pemberley." },
      { t: 'audio', audio: btoa('fake-mp3-b'), status: 'finished' },
      { t: 'done' },
    );
    const audio = audioEl();
    const onQuestion = vi.fn();
    const onAnswer = vi.fn();
    const onPlaybackStart = vi.fn();
    const onEnded = vi.fn();

    const result = await streamAnswer(
      new Blob(['question audio'], { type: 'audio/webm' }),
      'Pemberley prowled the moonlit library.',
      audio,
      { onQuestion, onAnswer, onPlaybackStart, onEnded },
    );

    expect(onQuestion).toHaveBeenCalledWith("What is the cat's name?");
    expect(onAnswer).toHaveBeenCalledWith("The cat's name is Pemberley.");
    expect(onPlaybackStart).toHaveBeenCalledTimes(1);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('blob:stepfun-answer');
    expect(result).toMatchObject({
      question: "What is the cat's name?",
      answer: "The cat's name is Pemberley.",
      backChannel: false,
      played: true,
    });

    audio.onended?.(new Event('ended'));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('buffers the complete answer even when MediaSource is available', async () => {
    const FakeMediaSource = vi.fn();
    (FakeMediaSource as unknown as { isTypeSupported: (mime: string) => boolean }).isTypeSupported = vi.fn(() => true);
    vi.stubGlobal('MediaSource', FakeMediaSource);
    mockStreamResponse(
      { t: 'meta', question: 'Can you switch languages?' },
      { t: 'audio', audio: btoa('fake-mp3-a'), status: 'unfinished' },
      { t: 'answer', answer: '当然可以，我们接下来用中文讲。' },
      { t: 'audio', audio: btoa('fake-mp3-b'), status: 'finished' },
      { t: 'done' },
    );
    const audio = audioEl();

    const result = await streamAnswer(
      new Blob(['question audio'], { type: 'audio/webm' }),
      'The story is about Pemberley.',
      audio,
    );

    expect(FakeMediaSource).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ answer: '当然可以，我们接下来用中文讲。', played: true });
  });

  it('treats narration echo as backChannel without playing audio', async () => {
    mockStreamResponse({ t: 'backChannel', echo: true }, { t: 'done' });
    const audio = audioEl();
    const onBackChannel = vi.fn();
    const onPlaybackStart = vi.fn();

    const result = await streamAnswer(
      new Blob(['echo audio'], { type: 'audio/webm' }),
      'Pemberley began her quiet nightly patrol.',
      audio,
      { onBackChannel, onPlaybackStart },
    );

    expect(onBackChannel).toHaveBeenCalledWith(true);
    expect(onPlaybackStart).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(result).toMatchObject({ backChannel: true, played: false });
  });

  it('keeps mic-check turns open for a follow-up instead of resuming narration', async () => {
    mockStreamResponse(
      { t: 'meta', question: 'Can you hear me?' },
      { t: 'answer', answer: 'I can hear you, my dear. What would you like to ask?', hold: true },
      { t: 'audio', audio: btoa('fake-mp3'), status: 'finished' },
      { t: 'done' },
    );
    const audio = audioEl();
    const onHold = vi.fn();
    const onEnded = vi.fn();

    const result = await streamAnswer(
      new Blob(['question audio'], { type: 'audio/webm' }),
      'Pemberley prowled the moonlit library.',
      audio,
      { onHold, onEnded },
    );

    expect(onHold).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ hold: true, backChannel: false, played: true });

    audio.onended?.(new Event('ended'));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('surfaces stream errors to the caller callback', async () => {
    mockStreamResponse({ t: 'error', message: 'tts ws closed' }, { t: 'done' });
    const audio = audioEl();
    const onError = vi.fn();

    const result = await streamAnswer(
      new Blob(['question audio'], { type: 'audio/webm' }),
      'Pemberley prowled the moonlit library.',
      audio,
      { onError },
    );

    expect(onError).toHaveBeenCalledWith('tts ws closed');
    expect(audio.play).not.toHaveBeenCalled();
    expect(result.played).toBe(false);
  });
});

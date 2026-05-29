#!/bin/bash
# Generate two test WAVs the user needs for Spike 3:
#
#   /tmp/spike-mic/question-immediate.wav
#     ~3 seconds, macOS `say` synthesising "What is moss?" — starts at t=0.
#
#   /tmp/spike-mic/question-after-5s.wav
#     5 seconds of silence + the question. Used to verify the user can
#     time the "interrupt" relative to session start.
#
# macOS only — uses `say` (built-in TTS) and `ffmpeg` (`brew install ffmpeg`).

set -euo pipefail
mkdir -p /tmp/spike-mic
cd /tmp/spike-mic

# Synth the question.
say -o question.aiff -v Samantha --rate=160 "What is moss?"
# Convert to 16kHz mono WAV — Agora's expected mic capture format.
ffmpeg -y -i question.aiff -ar 16000 -ac 1 question-immediate.wav

# Prefix with 5s silence.
ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=5" \
                  -i question-immediate.wav \
                  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" \
                  -map "[a]" question-after-5s.wav

# Looped 30s version — fake-mic plays the file in a loop, so a short WAV
# will repeat aggressively and confuse the agent. Pad with trailing silence.
ffmpeg -y -i question-immediate.wav \
       -af "apad=pad_dur=28" \
       -t 30 question-padded-30s.wav

echo
echo "Generated:"
ls -la /tmp/spike-mic/*.wav
echo
echo "Sanity check — play each (Cmd+C to stop):"
echo "  afplay /tmp/spike-mic/question-immediate.wav"
echo "  afplay /tmp/spike-mic/question-after-5s.wav"
echo "  afplay /tmp/spike-mic/question-padded-30s.wav"

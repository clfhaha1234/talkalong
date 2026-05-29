// Generate one WAV per case, following the pad-don't-loop pattern:
//   [leading_silence_s] + [content] + [trailing_silence_s]
//
// content depends on audio_source.type:
//   - "tts":     macOS `say` synthesises the text, ffmpeg downsamples to 16kHz mono
//   - "silence": just zeros for duration_s seconds
//
// Output: /tmp/spike-mic/barge-in/<case_id>.wav

import { readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CASES_PATH = join(__dirname, 'cases.json');
const OUT_DIR = '/tmp/spike-mic/barge-in';

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync('/tmp/spike-mic/barge-in/scratch', { recursive: true });

const cfg = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
const LEAD = cfg.leading_silence_s;
const TRAIL = cfg.trailing_silence_s;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

for (const c of cfg.cases) {
  const out = `${OUT_DIR}/${c.id}.wav`;
  const scratch = `/tmp/spike-mic/barge-in/scratch/${c.id}`;

  if (c.audio_source.type === 'tts') {
    const voice = c.audio_source.voice ?? 'Samantha';
    const text = c.audio_source.text.replace(/"/g, '\\"');
    // say → aiff → 16k mono wav
    sh(`say -o "${scratch}.aiff" -v "${voice}" --rate=160 "${text}"`);
    sh(`ffmpeg -y -i "${scratch}.aiff" -ar 16000 -ac 1 "${scratch}-content.wav" 2>/dev/null`);
  } else if (c.audio_source.type === 'silence') {
    const d = c.audio_source.duration_s;
    sh(`ffmpeg -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${d}" "${scratch}-content.wav" 2>/dev/null`);
  } else {
    throw new Error(`unknown audio_source.type for ${c.id}: ${c.audio_source.type}`);
  }

  // Compose: lead-silence + content + trail-silence
  sh(`ffmpeg -y \\
      -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${LEAD}" \\
      -i "${scratch}-content.wav" \\
      -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=16000:duration=${TRAIL}" \\
      -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]" -map "[a]" \\
      "${out}" 2>/dev/null`);

  const duration = sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}"`).trim();
  console.log(`${c.id} → ${out} (${duration}s)`);
}

console.log(`\nDone. All WAVs in ${OUT_DIR}/`);

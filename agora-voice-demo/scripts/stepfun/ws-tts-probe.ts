// Probe the StepFun streaming-TTS WebSocket: handshake, first-audio latency,
// chunk cadence, format support. Run: node --import tsx scripts/stepfun/ws-tts-probe.ts
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

for (const line of readFileSync(new URL('../../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.STEPFUN_API_KEY!;
const TEXT = 'The gentle, green-eyed cat patrolling the moonlit library is named Pemberley, little one.';

function probe(format: string, sampleRate: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ws = new WebSocket('wss://api.stepfun.ai/v1/realtime/audio?model=step-tts-2', {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const sid = 'probe-' + format;
    let firstAudio: number | null = null;
    let chunks = 0;
    let bytes = 0;
    const ms = () => Math.round(performance.now() - t0);

    const done = (note: string) => {
      console.log(`[${format}@${sampleRate}] ${note}  firstAudio=${firstAudio ?? '—'}ms total=${ms()}ms chunks=${chunks} bytes=${bytes}`);
      try { ws.close(); } catch {}
      resolve();
    };

    ws.on('open', () => {/* wait for connection.done */});
    ws.on('message', (raw) => {
      let ev: any;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case 'tts.connection.done':
          ws.send(JSON.stringify({ type: 'tts.create', data: { session_id: sid, voice_id: 'lively-girl', response_format: format, sample_rate: sampleRate } }));
          // feed the sentence as two deltas to exercise incremental input
          ws.send(JSON.stringify({ type: 'tts.text.delta', data: { session_id: sid, text: TEXT.slice(0, 40) } }));
          ws.send(JSON.stringify({ type: 'tts.text.delta', data: { session_id: sid, text: TEXT.slice(40) } }));
          ws.send(JSON.stringify({ type: 'tts.text.flush', data: { session_id: sid } }));
          ws.send(JSON.stringify({ type: 'tts.text.done', data: { session_id: sid } }));
          break;
        case 'tts.response.audio.delta': {
          if (firstAudio === null) firstAudio = ms();
          chunks++;
          const b64 = ev.data?.audio ?? ev.audio ?? '';
          bytes += Buffer.from(b64, 'base64').length;
          if (ev.data?.status === 'finished' || ev.status === 'finished') done('finished');
          break;
        }
        case 'tts.response.audio.done':
        case 'tts.done':
          done(ev.type);
          break;
        case 'error':
        case 'tts.error':
          done('ERR ' + JSON.stringify(ev).slice(0, 160));
          break;
        default:
          // log unknown event types once for protocol discovery
          if (!(ev.type in seen)) { seen[ev.type] = 1; console.log(`  · event ${ev.type} ${JSON.stringify(ev.data ?? {}).slice(0, 80)}`); }
      }
    });
    const seen: Record<string, number> = {};
    ws.on('error', (e) => done('WS-ERR ' + e.message));
    setTimeout(() => done('TIMEOUT'), 15000);
  });
}

(async () => {
  await probe('pcm', 16000);
  await probe('mp3', 16000);
  await probe('wav', 24000);
})();

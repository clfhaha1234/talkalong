// StepFun client smoke test: chains the three modalities the tutor needs and
// saves artifacts so we can eyeball quality + measure latency.
//   STEPFUN_API_KEY=... pnpm tsx scripts/stepfun/smoke.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { stepChat, stepImage, stepTTS } from '../../lib/stepfun/client';

const OUT = '/tmp/stepfun';
mkdirSync(OUT, { recursive: true });
const t = (label: string, ms: number) => console.log(`  ${label}: ${ms}ms`);

async function main() {
  console.log('=== StepFun smoke: story → image → narration TTS ===');

  // 1) LLM: draft a 1-scene story snippet + a fact for QA
  let t0 = Date.now();
  const story = await stepChat(
    [
      { role: 'system', content: 'You are a warm bedtime-story narrator for ages 8-12. Reply with ONLY the narration prose, 2 sentences.' },
      { role: 'user', content: 'Tell the opening of a story about a library cat named Pemberley.' },
    ],
    { reasoningEffort: 'low', maxTokens: 2048 },
  );
  t('chat (story)', Date.now() - t0);
  console.log('  story:', story.slice(0, 160));

  // 2) Image: a scene illustration
  t0 = Date.now();
  const imgUrl = await stepImage(
    'A cozy watercolor storybook illustration: a ginger library cat named Pemberley sitting among tall candlelit bookshelves at night, warm soft colors, no text.',
    { size: '1360x768', responseFormat: 'url' },
  );
  t('image', Date.now() - t0);
  console.log('  image url:', imgUrl.slice(0, 90));

  // 3) TTS: narrate the story snippet
  t0 = Date.now();
  const mp3 = await stepTTS(story || 'When the moon rose, Pemberley began her quiet patrol.', { voice: 'lively-girl' });
  t('tts', Date.now() - t0);
  const mp3Path = `${OUT}/narration.mp3`;
  writeFileSync(mp3Path, mp3);
  console.log(`  tts mp3: ${mp3Path} (${mp3.length} bytes)`);

  // 4) QA: answer a question (the LLM path the agent uses)
  t0 = Date.now();
  const answer = await stepChat(
    [
      { role: 'system', content: 'Answer the child in ONE short sentence, in character as the storyteller. Do not narrate further.' },
      { role: 'user', content: `Story so far: "${story}". Question: What is the cat's name?` },
    ],
    { reasoningEffort: 'low', maxTokens: 1024 },
  );
  t('chat (QA)', Date.now() - t0);
  console.log('  answer:', answer.slice(0, 120));

  console.log('\n=== RESULT ===');
  console.log(`  story ok: ${story.length > 0 ? '✅' : '❌'}`);
  console.log(`  image ok: ${imgUrl.startsWith('http') ? '✅' : '❌'}`);
  console.log(`  tts ok:   ${mp3.length > 1000 ? '✅' : '❌'}`);
  console.log(`  qa ok:    ${/pemberley/i.test(answer) ? '✅ (names cat)' : answer.length > 0 ? '⚠ answered but no name' : '❌'}`);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e.message);
  process.exit(1);
});

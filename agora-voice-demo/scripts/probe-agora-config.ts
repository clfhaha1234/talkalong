// Task 0 probe — verify how to plumb Phase 3 Agora Properties into a session.
//
// FINDING (without even running this): the SDK exposes typed builder methods
// on Agent for every Properties field we need. We just chain them like
// withLlm / withTts. No casts, no raw API.
//
// This probe confirms the builder methods accept our shapes and that the
// session.raw GET surfaces the config after start.

import {
  AgoraClient,
  Area,
  Agent,
  DeepgramSTT,
  MiniMaxTTS,
  OpenAI,
  ExpiresIn,
  type FillerWordsConfig,
  type TurnDetectionConfig,
  type AdvancedFeatures,
  type SessionParams,
} from 'agora-agent-server-sdk';
import { env } from './e1/lib/env.js';

const FILLER: FillerWordsConfig = {
  enable: true,
  trigger: {
    mode: 'fixed_time',
    fixed_time_config: { response_wait_ms: 800 },
  },
  content: {
    mode: 'static',
    static_config: {
      phrases: ['Hmm.', 'Let me see.', 'One sec.'],
      selection_rule: 'shuffle',
    },
  },
};

const TURN: TurnDetectionConfig = {
  config: {
    start_of_speech: { mode: 'vad' },
    end_of_speech: { mode: 'semantic' },
  },
};

const ADVANCED: AdvancedFeatures = {
  enable_rtm: true,
};

const PARAMS: SessionParams = {
  data_channel: 'rtm',
  enable_metrics: true,
  enable_error_message: true,
};

async function main() {
  const client = new AgoraClient({
    area: Area.US,
    appId: env.agoraAppId,
    appCertificate: env.agoraAppCertificate,
  });

  const agent = new Agent({
    name: `probe-config-${Date.now()}`,
    instructions: 'Silent narrator. Do not speak until told to.',
    greeting: '',
  })
    .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en-US' }))
    .withLlm(new OpenAI({ model: 'gpt-4o-mini' }))
    .withTts(new MiniMaxTTS({ model: 'speech_2_8_turbo', voiceId: 'English_captivating_female1' }))
    // Phase 3 config via builder pattern — no casts, fully typed:
    .withFillerWords(FILLER)
    .withTurnDetection(TURN)
    .withAdvancedFeatures(ADVANCED)
    .withParameters(PARAMS);

  const session = agent.createSession(client, {
    channel: `probe-${Date.now()}`,
    agentUid: '123456',
    remoteUids: ['*'],
    idleTimeout: 60,
    expiresIn: ExpiresIn.minutes(3),
    debug: false,
  });

  console.log('[probe] starting session with full Phase 3 config...');
  const t0 = Date.now();
  const agentId = await session.start();
  console.log(`[probe] start() OK in ${Date.now() - t0}ms — agentId=${agentId}`);

  // Verify the config landed by querying the agent's REST view
  try {
    const info = await session.raw.get({
      appid: client.appId,
      agentId,
    });
    const infoObj = info as unknown as { data?: Record<string, unknown> };
    const props = (infoObj?.data?.properties ?? infoObj?.data ?? {}) as Record<string, unknown>;
    console.log('\n[probe] raw.get() top-level keys:', Object.keys(props));
    console.log('  filler_words present:', !!props.filler_words);
    console.log('  turn_detection present:', !!props.turn_detection);
    console.log('  advanced_features present:', !!props.advanced_features);
    console.log('  parameters present:', !!props.parameters);
    if (props.filler_words) console.log('  filler_words:', JSON.stringify(props.filler_words));
    if (props.turn_detection) console.log('  turn_detection:', JSON.stringify(props.turn_detection));
    if (props.advanced_features) console.log('  advanced_features:', JSON.stringify(props.advanced_features));
    if (props.parameters) console.log('  parameters:', JSON.stringify(props.parameters));
  } catch (err) {
    console.log('[probe] raw.get() failed:', (err as Error).message);
  }

  console.log('\n[probe] stopping session...');
  await session.stop();
  console.log('[probe] done');
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});

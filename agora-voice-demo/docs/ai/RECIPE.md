# Quickstart Recipe Profile

This repo is a reusable quickstart sample for building browser voice-agent experiences with Agora Conversational AI Engine.

## Recipe Role

- Role: `base` quickstart recipe.
- Target audience: developers bootstrapping a production-style Next.js voice agent app.
- Reuse model: clone, bind project, run, then customize prompt/pipeline/UI.

## Stable Contracts Consumers Rely On

- Route interfaces:
- `GET /api/generate-agora-token`
- `POST /api/invite-agent`
- `POST /api/stop-conversation`
- Session bootstrap ownership:
- `components/LandingPage.tsx` owns pre-call bootstrap and RTM client lifecycle.
- `components/ConversationComponent.tsx` owns joined-session RTC/toolkit lifecycle.
- Transcript normalization helper boundary in `lib/conversation.ts`.

## Supported Customization Surface

- Agent persona, greeting, VAD, STT/LLM/TTS models in `app/api/invite-agent/route.ts`.
- Pre-call/in-call UX in `components/QuickstartPreCallCard.tsx` and layout components.
- Optional BYOK path through commented provider blocks and env vars.

## Invariants

- Keep `RtcTokenBuilder.buildTokenWithRtm` for RTM-capable tokens.
- Preserve StrictMode `isReady` guard for join/mic initialization.
- Preserve UID remap (`uid="0"`) and `INTERRUPTED` message-list inclusion.
- Keep documentation synchronized when workflows/contracts change.

## Consumer Onboarding Recipe

1. Clone or scaffold from template.
2. Bind Agora project and write `.env.local`.
3. Run `pnpm run doctor` and `pnpm run dev`.
4. Validate with `pnpm run verify` before sharing modifications.
5. Customize agent behavior and UI using the supported surfaces above.

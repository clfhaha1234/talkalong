# 05 Workflows

> Repeatable task recipes for common quickstart changes and validation loops.

## Run Locally

1. `pnpm install`
2. `agora login`
3. `agora project use <your-project>`
4. `agora project env write .env.local`
5. `pnpm run doctor`
6. `pnpm run dev`

If start fails, run `agora project doctor --deep`.

## Change Agent Behavior

Target file: `app/api/invite-agent/route.ts`.

Typical edits:

- System prompt (`ADA_PROMPT`).
- Greeting default (`NEXT_AGENT_GREETING`).
- VAD (`turnDetection.config.*`).
- STT/LLM/TTS model/provider blocks.

Validation path:

1. `pnpm run lint`
2. `pnpm run typecheck`
3. `pnpm run verify:api`
4. `pnpm run build`

## Change Token or Session Bootstrap

Token behavior:

- Edit `app/api/generate-agora-token/route.ts`.
- Preserve RTM-capable token generation.

Bootstrap behavior:

- Edit `components/LandingPage.tsx`.
- Keep invite + RTM setup parallelized before conversation mount.

## Change Transcript Rendering

1. Update transforms in `lib/conversation.ts`.
2. Update wiring in `components/ConversationComponent.tsx`.
3. Ensure `IN_PROGRESS` is separated from history, `INTERRUPTED` retained in history.
4. Re-check `docs/TEXT_STREAMING_GUIDE.md` for consistency.

## Ship-Readiness Workflow

1. Run `pnpm run verify`.
2. Confirm docs alignment (`README`, guides, `AGENTS`, `docs/ai`).
3. Use conventional commit and branch naming.

## Progressive Disclosure Doc Workflow

- `generate docs`: create `docs/ai/` tree when absent.
- `update docs`: refresh after workflow/interface/security changes.
- `test docs`: execute question-based validation and write `docs/ai/test-results.md`.

## Workflow: Add a New API Route

1. Add route under `app/api/<route-name>/route.ts`.
2. Define payload types in `types/conversation.ts` if shared with client.
3. Add/update contract verification in `scripts/verify-api-contracts.ts`.
4. Run `pnpm run verify:api` and `pnpm run typecheck`.
5. Update `README.md` and `docs/ai/L1/06_interfaces.md`.

## Workflow: Modify Transcript UX

1. Update transforms in `lib/conversation.ts`.
2. Update render usage in transcript/layout components.
3. Validate edge states (`IN_PROGRESS`, `INTERRUPTED`, empty history).
4. Reconcile guidance in `docs/TEXT_STREAMING_GUIDE.md`.
5. Run `pnpm run lint` and `pnpm run build`.

## Workflow: Enable BYOK Provider Path

1. Uncomment relevant provider block in invite route.
2. Add env vars to `.env.local` and `env.local.example`.
3. Keep default no-key path intact for baseline quickstart behavior.
4. Document changes in README environment section.
5. Re-run `pnpm run verify` before shipping.

## Workflow: Docs Refresh After Runtime Changes

1. Update L1 files matching changed subsystem.
2. Update or add L2 deep dives if L1 explanation exceeds concise bounds.
3. Bump `Last Reviewed` in `L0_repo_card.md`.
4. Re-run docs test and append retest notes for any fixes.

## Related Deep Dives

- [conversation_lifecycle.md](L2/conversation_lifecycle.md) — Full runtime sequence for bootstrap and teardown tasks.
- [transcript_pipeline.md](L2/transcript_pipeline.md) — Required checks when editing transcript flow.

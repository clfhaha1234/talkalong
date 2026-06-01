// DEV/TEST-ONLY preview of StoryScreen with canned fixtures — NO Agora, NO API,
// NO mic. Mounts StoryScreen inside the exact same ScalingStage wrapper the real
// /tutor uses (components/TutorPage.tsx), so the CSS `transform: scale()`
// environment — where the feed-scroll / chapter-pin / composer-visibility bugs
// lived — is faithfully reproduced in a real browser.
//
// This is what the Tier-2 Playwright smoke (scripts/e2e/tutor-storyscreen-smoke.mjs)
// drives: real-browser LAYOUT assertions (composer in viewport, feed scrollable)
// that jsdom (Tier 1) structurally cannot make because it has no layout engine.
//
// Server component reads ?variant= and hands a serializable string to the client
// half (PreviewClient) — no client-side window reading, so no hydration mismatch.
// Variants: reading (default) | muted | listening | paused | finished | broken-image

import { PreviewClient, type PreviewVariant } from './PreviewClient';

const VALID: PreviewVariant[] = ['reading', 'muted', 'listening', 'paused', 'finished', 'broken-image'];

export default async function StoryScreenPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const sp = await searchParams;
  const variant = (VALID.includes(sp.variant as PreviewVariant) ? sp.variant : 'reading') as PreviewVariant;
  return <PreviewClient variant={variant} />;
}

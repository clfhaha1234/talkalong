'use client';

// Tutor page — Agora RTC SDK touches `window` at module load, so this
// component must be client-only. next/dynamic with ssr: false gives us that.

import dynamic from 'next/dynamic';

const TutorPage = dynamic(() => import('@/components/TutorPage'), { ssr: false });

export default function TutorRoute() {
  const agoraAppId = process.env.NEXT_PUBLIC_AGORA_APP_ID ?? '';
  if (!agoraAppId) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10 font-sans">
        <h1 className="text-2xl font-semibold">Talkthrough — Phase 1 demo</h1>
        <div className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          NEXT_PUBLIC_AGORA_APP_ID is not set. Configure your .env.local and reload.
        </div>
      </div>
    );
  }
  return <TutorPage agoraAppId={agoraAppId} />;
}

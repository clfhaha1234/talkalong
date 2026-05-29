import type { Metadata, Viewport } from 'next';
import { EB_Garamond, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Storybook tutor fonts. EB Garamond is the headline + body face; JetBrains
// Mono is the "scientific marginalia" face on the loading bar and ribbons.
// We expose them as CSS variables so `components/tutor/theme.ts` can
// reference them via var(--font-eb-garamond) / var(--font-jetbrains-mono).
const ebGaramond = EB_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-eb-garamond',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export const metadata: Metadata = {
  title: 'Talk to your voice agent | Agora',
  description:
    "Next.js quickstart: real-time voice agent with live transcript, streaming audio, and low latency from Agora's Conversational AI Engine—API routes in one repo.",
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png' }],
    other: [
      {
        url: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        url: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full ${ebGaramond.variable} ${jetbrainsMono.variable}`}
    >
      <body className="h-full min-h-screen">{children}</body>
    </html>
  );
}

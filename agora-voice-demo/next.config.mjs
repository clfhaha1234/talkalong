import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // The deployed product IS the AI tutor — send the site root straight to it
  // (the raw `/` Agora 1:1 demo stays reachable only if you hit it directly via
  // a deep link; 307 so it's easy to revert).
  async redirects() {
    return [{ source: '/', destination: '/tutor', permanent: false }];
  },
  turbopack: {
    root: rootDir,
  },
  // This app lives in a subdirectory; the REPO ROOT is a separate ~366MB
  // Remotion project (with a package-lock.json). Without pinning the tracing
  // root, Next picks the repo root and bundles that sibling project's
  // node_modules into every serverless function — the /api/lesson/start lambda
  // hit 571MB (>300MB Vercel limit). Pin tracing to this app dir, and drop
  // heavy deps that are only used by dev/eval scripts, never at request time.
  outputFileTracingRoot: rootDir,
  outputFileTracingExcludes: {
    '*': [
      // Runtime-generated lesson media — the real bloat (589MB of mp4/jpg from
      // local dev runs). Never a function input; regenerated at request time.
      'public/lesson-cache/**',
      'node_modules/playwright/**',
      'node_modules/playwright-core/**',
      'node_modules/@img/**',
      'node_modules/@esbuild/**',
      'node_modules/typescript/**',
      'scripts/**',
    ],
  },
  experimental: {
    webpackBuildWorker: true,
    parallelServerBuildTraces: true,
    parallelServerCompiles: true,
  },
};

export default nextConfig;

import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = { '@': path.resolve(__dirname, './') };

// Two projects so the fast pure-logic suite stays in Node (no DOM overhead),
// while React component-render tests get a jsdom environment + jest-dom
// matchers. Component tests are named *.render.test.tsx to keep them out of
// the Node project's glob.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'lib/**/*.test.ts',
            'scripts/**/*.test.ts',
            'app/**/*.test.ts',
            // components/ holds pure logic extracted from React components
            // (e.g. transcript-mapping) so the browser-bug regressions are
            // unit-tested.
            'components/**/*.test.ts',
          ],
          globals: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['components/**/*.render.test.tsx'],
          setupFiles: ['./vitest.setup.jsdom.ts'],
          globals: false,
        },
      },
    ],
  },
});

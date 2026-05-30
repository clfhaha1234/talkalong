import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'scripts/**/*.test.ts',
      'app/**/*.test.ts',
      // components/ holds pure logic extracted from React components (e.g.
      // transcript-mapping) so the browser-bug regressions are unit-tested.
      'components/**/*.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});

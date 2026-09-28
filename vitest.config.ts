import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // #1272 — JSX compiles the way the app compiles it (tsconfig.app.json `"jsx": "react-jsx"`).
  // Without this vitest's transform used the classic runtime, so a test rendering JSX had to import
  // `React` for a value TypeScript then reported unused (TS6133): two compilers, two answers.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'happy-dom',
    globals: false,
    // `scripts/` is included so the e2e merge gate's own logic (#463) is tested
    // alongside the script it guards, rather than parked under src/ away from it.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    exclude: ['tests/**/*', 'node_modules/**/*'],
  },
});

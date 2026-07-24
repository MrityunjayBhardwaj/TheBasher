import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    // `scripts/` is included so the e2e merge gate's own logic (#463) is tested
    // alongside the script it guards, rather than parked under src/ away from it.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    exclude: ['tests/**/*', 'node_modules/**/*'],
  },
});

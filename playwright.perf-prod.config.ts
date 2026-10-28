// #1727 — the playback perf table against a production build (`vite.perf.config.ts`), served by
// `vite preview`. `npm run perf:prod`.
import base from './playwright.config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: 'http://localhost:5187' },
  webServer: {
    command:
      'npx vite build -c vite.perf.config.ts && npx vite preview -c vite.perf.config.ts --port 5187 --strictPort',
    url: 'http://localhost:5187',
    reuseExistingServer: false,
    timeout: 600_000,
  },
});

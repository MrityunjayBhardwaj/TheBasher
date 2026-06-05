import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  // #175 — the heaviest e2e (full ingest→bake→reload→re-render chains:
  // p151 M8, p7.14 rename, p1 drag-drop) run ~7s locally (~6 cores) but
  // ~4-5× slower on a 2-vCPU software-GL (SwiftShader) CI runner, straddling
  // the un-tuned 30s Playwright default → boundary flakes (always ~31s, the
  // failing test varies with runner load). These are PROVEN deterministic
  // (11/11 local, never near 30s — no race), so the budget, not the logic,
  // was too small. Give CI headroom; keep local fast-fail at 30s to catch
  // genuine hangs while iterating. Sibling of hetvabhasa H16's wall-clock
  // meta-pattern (cause here = budget, not a missing await).
  timeout: process.env.CI ? 60_000 : 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

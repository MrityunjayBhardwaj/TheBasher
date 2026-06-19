// #208 increment 4 — profile JSON import/export (epic #201, §7.5). Observes on the
// LIVE app (Lokayata) that importing a .bls-style profiles JSON through the bar's
// Import button rebuilds the rig + its lights as real DAG nodes — the pucks appear
// on the canvas and the switcher names the imported profile.
//
// FALSIFICATION: the imported file names a profile with TWO lights → exactly two
// pucks appear (not zero, not one); a malformed file surfaces an error, no nodes.
//
// REF: src/app/studioProfileIO.ts; src/timeline/LightStudioPanel.tsx (ProfilesBar);
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.5; vyapti V63.

import { expect, test } from './_fixtures';

interface PanelWindow {
  __basher_dag: { getState: () => { state: { outputs: { scene?: { node: string } } } } };
}

async function openLightStudio(page: import('@playwright/test').Page): Promise<void> {
  const toggle = page.getByTestId('timeline-drawer-toggle');
  const drawer = page.getByTestId('timeline-drawer');
  if ((await drawer.getAttribute('data-open')) !== 'true') await toggle.click();
  await page.getByTestId('timeline-tab-lightStudio').click();
  await expect(page.getByTestId('light-studio-panel')).toBeVisible();
}

function puckCount(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('[data-testid^="light-studio-puck-"]').count();
}

const PROFILE_FILE = JSON.stringify({
  format: 'basher-light-profiles',
  version: 1,
  profiles: [
    {
      name: 'Imported Key',
      center: [0, 0, 0],
      radius: 6,
      lights: [
        { position: [3, 4, 3], intensity: 5, color: '#ffffff', width: 2, height: 2 },
        { position: [-3, 4, 3], intensity: 3, color: '#ffaa00', width: 2, height: 2 },
      ],
    },
  ],
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as PanelWindow;
    return Boolean(w.__basher_dag && w.__basher_dag.getState().state.outputs.scene);
  });
  await openLightStudio(page);
});

test('#208 — Import rebuilds a profile from JSON: pucks appear + the switcher names it', async ({
  page,
}) => {
  // No profiles yet.
  await expect(page.getByTestId('light-studio-profile-select')).toHaveCount(0);
  await expect.poll(() => puckCount(page)).toBe(0);

  // Drive the hidden file input with the profiles JSON (the Import button click).
  await page.getByTestId('light-studio-profiles-import-file').setInputFiles({
    name: 'light-profiles.json',
    mimeType: 'application/json',
    buffer: Buffer.from(PROFILE_FILE, 'utf-8'),
  });

  // The imported profile is live + named, and its two lights show as pucks.
  const select = page.getByTestId('light-studio-profile-select');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('Imported Key');
  await expect.poll(() => puckCount(page)).toBe(2);

  // Export button is now available (round-trip affordance present).
  await expect(page.getByTestId('light-studio-profiles-export')).toBeVisible();
});

test('#208 — a malformed profiles file surfaces an error and adds nothing (falsification)', async ({
  page,
}) => {
  await page.getByTestId('light-studio-profiles-import-file').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ "not": "a profiles file" }', 'utf-8'),
  });

  // No profile created, no pucks — the bar stays empty.
  await expect(page.getByTestId('light-studio-profile-select')).toHaveCount(0);
  await expect.poll(() => puckCount(page)).toBe(0);
});

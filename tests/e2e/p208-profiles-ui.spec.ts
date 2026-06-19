// #208 increment 3 — the Profiles bar (epic #201, §7.5). Observes on the LIVE app
// (Lokayata) the BLS-grounded profile workflow driven entirely through the UI: add a
// profile, add lights into it, add a SECOND profile, switch between them, and watch
// the canvas re-scope to the active profile's pucks. This is the user-facing proof
// that the substrate (LightRig + LightProfileSelect, increments 1–2) is wired to a
// real surface — the switcher changes what the director sees.
//
// FALSIFICATION (guards a vacuous pass): the two profiles hold a DIFFERENT number of
// lights, so the puck count after switching distinguishes "the switch worked" from
// "nothing changed"; deleting a profile drops its pucks.
//
// REF: src/timeline/LightStudioPanel.tsx (ProfilesBar); src/app/studioProfiles.ts;
//      docs/OPERATORS-AND-LIGHTING-DESIGN.md §7.5; vyapti V63.

import { expect, test } from './_fixtures';

interface PanelWindow {
  __basher_dag: { getState: () => { state: { outputs: { scene?: { node: string } } } } };
}

/** Open the timeline drawer (if collapsed) and switch to the Light Studio tab. */
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

test('#208 — add / switch / delete profiles via the bar; the canvas re-scopes to the active one', async ({
  page,
}) => {
  const bar = page.getByTestId('light-studio-profiles-bar');
  await expect(bar).toBeVisible();
  // No profiles yet → no switcher, the empty hint shows.
  await expect(page.getByTestId('light-studio-profile-select')).toHaveCount(0);

  // + Profile (the first) → a switcher appears, naming "Profile 1".
  await page.getByTestId('light-studio-profile-add').click();
  const select = page.getByTestId('light-studio-profile-select');
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('Profile 1');

  // Add TWO lights into Profile 1 (they belong to the active rig).
  await page.getByTestId('light-studio-add').click();
  await page.getByTestId('light-studio-add').click();
  await expect.poll(() => puckCount(page)).toBe(2);

  // + Profile (the second) → "Profile 2", now active and EMPTY → 0 pucks.
  await page.getByTestId('light-studio-profile-add').click();
  await expect(select).toHaveValue('Profile 2');
  await expect.poll(() => puckCount(page)).toBe(0);

  // Add ONE light into Profile 2.
  await page.getByTestId('light-studio-add').click();
  await expect.poll(() => puckCount(page)).toBe(1);

  // Switch back to Profile 1 via the dropdown → its 2 pucks return (the switch
  // re-scopes the canvas; falsified by the distinct counts 2 vs 1).
  await select.selectOption('Profile 1');
  await expect(select).toHaveValue('Profile 1');
  await expect.poll(() => puckCount(page)).toBe(2);

  // Delete Profile 1 → the select re-points to Profile 2 (the survivor, 1 puck).
  await page.getByTestId('light-studio-profile-delete').click();
  await expect(select).toHaveValue('Profile 2');
  await expect.poll(() => puckCount(page)).toBe(1);
});

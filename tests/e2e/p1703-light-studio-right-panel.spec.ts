// #1703 — the Light Studio lives in the right panel's Lights tab, not the bottom drawer: the
// drawer has no Light Studio tab, the right panel switches between Inspector and Lights, and the
// studio still works there (a light added from it appears as a puck on its sphere).
import { expect, test } from './_fixtures';
import { openInspector, openLightStudio } from './_rightPanel';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('the drawer has no Light Studio tab', async ({ page }) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-tab-strip')).toBeVisible();
  await expect(page.getByTestId('timeline-tab-lightStudio')).toHaveCount(0);
  await expect(page.getByTestId('light-studio-pane')).toHaveCount(0);
});

test('the right panel switches between Inspector and Lights, and the studio works there', async ({
  page,
}) => {
  await expect(page.getByTestId('inspector-tab-inspector')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await openLightStudio(page);
  await expect(page.getByTestId('inspector-tab-lights')).toHaveAttribute('aria-selected', 'true');
  // The studio fits the panel: nothing of it spills past the panel's right edge.
  const slot = (await page.getByTestId('inspector-slot').boundingBox())!;
  const canvas = page.getByTestId('light-studio-canvas');
  const c = (await canvas.boundingBox())!;
  expect(c.x + c.width).toBeLessThanOrEqual(slot.x + slot.width + 0.5);
  expect(c.width).toBeGreaterThan(150);
  expect(c.height).toBeGreaterThan(60);

  // Adding a light from the studio puts a puck on its sphere.
  const pucks = canvas.locator('[data-testid^="light-studio-puck-"]');
  const before = await pucks.count();
  await page.getByTestId('light-studio-add').click();
  await expect(pucks).toHaveCount(before + 1);

  await openInspector(page);
  await expect(page.getByTestId('inspector-tab-inspector')).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

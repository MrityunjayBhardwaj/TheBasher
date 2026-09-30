// #1333 — the inspector offers a lobe's map rows only while that lobe is on.
//
// Since the lobe textures arrived (#1327, #1328, #1331) the Maps section listed every slot on every
// material. The user's call: a lobe's rows show only while its weight is above 0. The six original
// slots always show. Driven through the inspector's own coat-weight input, the way a user turns
// the coat on and off, and read as the rendered map rows (their file inputs), not as the table.
//
// REF: src/nodes/types.ts (`MATERIAL_MAP_SLOT_TABLE`, `weightOf`);
//      src/app/material/attachMapFromFile.ts (`shownMapSlots`); src/app/NPanel.tsx; issue #1333.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

interface BasherWindow {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
}

const SIX = ['albedo', 'normal', 'roughness', 'metalness', 'emissive', 'ao'];
const COAT = ['coat', 'coatRoughness', 'coatNormal'];

async function selectBoxAndOpenMaterial(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as BasherWindow).__basher_selection));
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  const editor = page.getByTestId('inspector-material-editor-n_box_data');
  if (!(await editor.isVisible())) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(editor).toBeVisible();
}

/** The slots the Maps section renders a row for, in order. */
const mapRows = (page: Page) =>
  page
    .locator('[data-testid^="inspector-map-file-n_box_data-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.replace('inspector-map-file-n_box_data-', '')),
    );

async function setCoatWeight(page: Page, value: string): Promise<void> {
  const input = page.locator(
    '[data-testid^="inspector-input-n_box_data-"][data-testid$=".coat.weight"]',
  );
  await expect(input).toHaveCount(1);
  await input.fill(value);
  await input.press('Enter');
}

test('#1333 — a box shows its coat map rows only while its coat is on', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await selectBoxAndOpenMaterial(page);

  // The default box has no coat and no transmission: the six original rows and nothing else.
  await expect.poll(() => mapRows(page)).toEqual(SIX);

  await setCoatWeight(page, '0.5');
  await expect.poll(() => mapRows(page)).toEqual([...SIX, ...COAT]);

  await setCoatWeight(page, '0');
  await expect.poll(() => mapRows(page)).toEqual(SIX);
  expect(errors).toEqual([]);
});

// #1703 — the one road a spec takes to the Light Studio: the right panel's Lights tab (it left the
// bottom drawer). Expands the panel first if it was folded.
import { expect, type Page } from '@playwright/test';

export async function openLightStudio(page: Page): Promise<void> {
  const expand = page.getByTestId('inspector-expand-toggle');
  if (await expand.count()) await expand.click();
  await page.getByTestId('inspector-tab-lights').click();
  await expect(page.getByTestId('inspector-slot').getByTestId('light-studio-panel')).toBeVisible();
  // The studio is one column in a panel that scrolls; its sphere sits at the bottom (design board
  // "Lighting"), so bring it into view before a spec measures or drags on it.
  await page.getByTestId('light-studio-canvas').scrollIntoViewIfNeeded();
}

/** Back to the inspector (the selected node's params). */
export async function openInspector(page: Page): Promise<void> {
  await page.getByTestId('inspector-tab-inspector').click();
  await expect(page.getByTestId('light-studio-panel')).toHaveCount(0);
}

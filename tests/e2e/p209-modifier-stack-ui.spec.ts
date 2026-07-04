// #209 increment 3 — the Modifier-stack inspector UI (epic #201, §5; the
// OperatorStack's authoring surface). Observes on the LIVE app that clicking
// "+ Array" in the selected mesh's Modifiers section actually adds a modifier to
// the DAG and the viewport re-renders the MERGED array; that muting it (the row's
// ● toggle) bypasses the operator; and that a second add + delete drives the stack
// — every action through operatorStack's atomic Op builders.
//
// REF: src/app/ModifierStackControls.tsx; src/app/operatorStack.ts;
//      src/app/NPanel.tsx (the 'modifier' section); vyapti V58.

import { expect, test } from './_fixtures';

interface UiWindow {
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_three: { getState: () => { scene: ThreeSceneLike | null } };
}
interface ThreeSceneLike {
  traverse: (cb: (o: ThreeObjLike) => void) => void;
}
interface ThreeObjLike {
  type: string;
  geometry?: { attributes?: { position?: { count: number } } };
}

const ARRAYED = 72; // 3 copies of the default unit box (24 verts) merged

function hasMeshWithVerts(page: import('@playwright/test').Page, want: number): Promise<boolean> {
  return page.evaluate((n) => {
    const w = window as unknown as UiWindow;
    const scene = w.__basher_three.getState().scene;
    let found = false;
    scene?.traverse((o) => {
      const g = (o as ThreeObjLike).geometry?.attributes?.position;
      if ((o as ThreeObjLike).type === 'Mesh' && g && g.count === n) found = true;
    });
    return found;
  }, want);
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
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as UiWindow).__basher_selection &&
      (window as unknown as UiWindow).__basher_three,
    ),
  );
  // Select the default box and reveal its Modifiers section (default-collapsed).
  await page.evaluate(() =>
    (window as unknown as UiWindow).__basher_selection.getState().select('n_box'),
  );
  await page.getByTestId('inspector-section-toggle-modifier').click();
});

test('#209 — "+ Array" adds a modifier and the viewport renders the merged array', async ({
  page,
}) => {
  const stack = page.getByTestId('modifier-stack');
  await expect(stack).toBeVisible();
  await expect(stack.getByText('No modifiers.')).toBeVisible();

  await page.getByTestId('modifier-add-ArrayModifier').click();

  // A modifier row appears in the stack...
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  // ...and the live viewport now renders the 72-vert merged array.
  await expect.poll(() => hasMeshWithVerts(page, ARRAYED), { timeout: 10_000 }).toBe(true);

  // Mute the modifier (the row's ● toggle) → the operator is bypassed, the merged
  // array is gone from the live scene.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => hasMeshWithVerts(page, ARRAYED), { timeout: 10_000 }).toBe(false);

  // Un-mute → it comes back.
  await stack.locator('[data-testid^="modifier-mute-"]').first().click();
  await expect.poll(() => hasMeshWithVerts(page, ARRAYED), { timeout: 10_000 }).toBe(true);
});

test('#209 — a second add stacks, and delete removes a modifier', async ({ page }) => {
  const stack = page.getByTestId('modifier-stack');
  await page.getByTestId('modifier-add-ArrayModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
  await page.getByTestId('modifier-add-ArrayModifier').click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(2);

  // Delete the first row → back to one modifier (chain splices closed).
  await stack.locator('[data-testid^="modifier-remove-"]').first().click();
  await expect(stack.locator('[data-testid^="modifier-row-"]')).toHaveCount(1);
});

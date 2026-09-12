// A view lock that cannot follow anything says so (#984).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SPEC AND NOT ONLY A UNIT ROW
// ─────────────────────────────────────────────────────────────────────────
// `viewLock.test.ts` pins the decision: locking to something with no point
// returns a refusal and takes no lock. It cannot pin that a DIRECTOR is told,
// because the link between the two is the menu handler reading the outcome and
// pushing a toast — and a handler that dropped it on the floor would leave every
// unit row green while restoring the exact silence this issue is about. That
// gap is the whole reason the issue was filed one layer in from #856.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY A LIGHT
// ─────────────────────────────────────────────────────────────────────────
// It is in the default seed, so this needs no fixture, and it is the case the
// issue leads with: a light's glyphs are editor chrome and are pruned from the
// bounds, so the group named with its node id RESOLVES and yields no point.
// That the lookup succeeds is the trap — nothing is null, no guard fires, and
// the lock used to latch its checkmark beside a view that never moved.
//
// The cube leg is not a preamble. "Locking to a light refuses" is equally true
// of a check that refuses everything, which would break the feature outright
// while passing the first half of this spec.
//
// REF: src/app/viewLock.ts (the decision); src/app/MenuBar.tsx (the wiring this
//      spec exists for); src/viewport/followScan.ts; issues #984, #856.

import { test, expect } from './_fixtures';

/** The item's label, which carries the checkmark. Closed by re-clicking the
 *  menu and never by Escape — Escape also clears the selection. */
async function menuLabel(page: import('@playwright/test').Page) {
  await page.getByTestId('menu-view').click();
  const label = (await page.getByTestId('menu-view-lock-to-selected').textContent()) ?? '';
  await page.getByTestId('menu-view').click();
  await page.waitForTimeout(200);
  return label;
}

async function lockSelected(page: import('@playwright/test').Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('menu-view-lock-to-selected').click();
  await page.waitForTimeout(600);
}

test('locking to a light refuses and says why; the cube still locks', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('scene-tree-row-n_light').click();
  await page.waitForTimeout(600);
  await lockSelected(page);

  const toast = page.getByTestId('toast-warn');
  await expect(toast, 'locking to a light said nothing at all').toHaveCount(1);
  await expect(toast).toBeVisible();
  expect(await toast.textContent()).toContain('Nothing to follow');
  expect(
    await menuLabel(page),
    'a lock latched on something the view cannot follow — the silence this issue is about',
  ).not.toContain('✓');

  // ── THE LOSING ALTERNATIVE ──
  await page.getByTestId('scene-tree-row-n_box').click();
  await page.waitForTimeout(600);
  await lockSelected(page);
  expect(
    await menuLabel(page),
    'the cube did not lock either, so the refusal refuses everything',
  ).toContain('✓');
});

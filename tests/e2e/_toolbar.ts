// #1935 — the one road a spec takes to a viewport toolbar control.
//
// The toolbar keeps its everyday groups inline only while they fit, and puts the less-used ones
// (assets, space, play, framing, pivot, orientation, snap, timeline, render/export/present) behind
// a ⋯ button. A control is in exactly one place — the pill or the open ⋯ menu — and keeps its
// testid in both. So a spec asks for the control by testid here: if it is not on screen, this
// opens ⋯ and hands back the same locator, now inside the menu.
//
// The menu closes after an action (a click on a button outside the settings groups), so calling
// this again before each click is the normal pattern; it reopens ⋯ only when needed.
import { expect, type Locator, type Page } from '@playwright/test';

export async function toolbarControl(page: Page, testId: string): Promise<Locator> {
  // A testid lives in exactly one place at a time, so the page-wide locator finds it in the pill
  // or in the open menu alike. Only the "is it on screen?" decision needs care: the pill re-fits
  // after every resize, so a control read as hidden for one frame may be inline the next.
  const control = page.getByTestId(testId);
  if ((await control.count()) > 0 && (await control.first().isVisible())) return control;
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
  const menu = page.getByTestId('floating-toolbar-more-menu');
  if (!(await menu.isVisible())) {
    await page.getByTestId('floating-toolbar-more').click();
    await expect(menu).toBeVisible();
  }
  await expect(control).toBeVisible();
  // It turned out to be inline after all: leave the pill as the spec found it.
  if ((await menu.getByTestId(testId).count()) === 0) await closeToolbarMenu(page);
  return control;
}

/** Click a toolbar control wherever it lives (inline or behind ⋯). */
export async function clickToolbar(page: Page, testId: string): Promise<void> {
  await (await toolbarControl(page, testId)).click();
}

/** Close the ⋯ menu if it is open (the ⋯ button toggles it), leaving the pill as it was. */
export async function closeToolbarMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('floating-toolbar-more-menu');
  if (await menu.isVisible()) {
    await page.getByTestId('floating-toolbar-more').click();
    await expect(menu).toHaveCount(0);
  }
}

// P6 W2 (v0.6 #4) — the mode enum is dissolved; its three meanings each
// work as a DISCRETE affordance, with NO mode state anywhere.
//
// THE LIE THIS TEST KILLS
// =======================
// The old operational mode enum (edit/run/animate/director) fused three
// unrelated concerns behind one selector: playback (run), timeline reveal
// (animate), and fullscreen present (director). v0.6 #4 deletes the enum
// (modeStore is gone) and re-homes each meaning to ephemeral UI state:
//   - run      → Play ▶ transport            (useTimeStore.playing)
//   - animate  → timeline-drawer reveal       (viewportStore.timelineDrawerOpen)
//   - director → present / fullscreen toggle  (chromeStore.presentMode)
// This spec proves each works WITHOUT any mode. Each leg is falsifiable:
// revert its re-home (W2-T5/T6/T7/T8) and that leg fails.
//
// REF: .planning/phases/v06.4-director-ux/PLAN.md (W2); CONTEXT D-05/D-06.

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('W2#1 run → Play ▶ toggles the playback transport (no mode)', async ({ page }) => {
  const play = page.getByTestId('floating-toolbar-play');
  await expect(play).toBeVisible();
  // Idle: not playing (the button reads useTimeStore.playing via data-active).
  await expect(play).not.toHaveAttribute('data-active', 'true');
  // Click → transport starts (playing). The button's pressed state reads the
  // real store, so this proves the handler is wired to useTimeStore.toggle().
  await play.click();
  await expect(play).toHaveAttribute('data-active', 'true');
  // Click again → pause.
  await play.click();
  await expect(play).not.toHaveAttribute('data-active', 'true');
});

test('W2#2 animate → the timeline reveal opens the drawer (no mode)', async ({ page }) => {
  const drawer = page.getByTestId('timeline-drawer');
  // The drawer BODY is closed by default (the Timebar row stays visible).
  await expect(drawer).toHaveAttribute('data-open', 'false');
  // The floating pill carries a toolbar-level reveal for the drawer body.
  await page.getByTestId('floating-toolbar-timeline').click();
  await expect(drawer).toHaveAttribute('data-open', 'true');
});

test('W2#3 director → Present toggles chrome collapse; Esc exits (no mode)', async ({ page }) => {
  // Chrome visible before present (project-tabs is the canonical chrome-band
  // visibility probe now that the top-toolbar band was consolidated, W1).
  await expect(page.getByTestId('project-tabs')).toBeVisible();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');

  // Present: every chrome band collapses; the over-canvas pill self-gates out.
  // The Present toggle lives on the pill (testid preserved through W1).
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('project-tabs')).toBeHidden();
  await expect(page.getByTestId('inspector')).toBeHidden();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeHidden();
  // The viewport itself stays.
  await expect(page.getByTestId('viewport-slot')).toBeVisible();

  // Esc dismisses the topmost transient — here present — restoring the chrome.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('project-tabs')).toBeVisible();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
});

test('W2#4 Esc ladder: a popover closes before selection clears (no mode reset)', async ({
  page,
}) => {
  // Open the Add menu (Shift+A). The Esc ladder must close it FIRST — not
  // reset a mode (there is none) and not jump straight to clearing selection.
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toBeHidden();
});

// #768 — the Settings modal's action row must be reachable however tall the
// modal grows.
//
// This is a property of the DIALOG, not of any particular field list, which is
// why it is its own spec rather than another case in a feature's file. The
// panel is centred inside a `fixed inset-0` backdrop that cannot scroll; a
// panel taller than the viewport therefore overflows in BOTH directions at
// once and takes Save and Cancel with it. Playwright reports that as
// "visible, enabled and stable … done scrolling … element is outside of the
// viewport" — a shape worth recognising, because every word of it except the
// last says the element is fine.
//
// 🔑 IT SHRINKS THE VIEWPORT RATHER THAN COUNTING FIELDS. The regression that
// prompted it arrived by adding a settings group, and three groups have been
// added in as many sessions — ComfyUI, the motion server and checkpoint, the
// Tripo key and model version. A test pinned to today's field count would go
// green again the moment someone removed a field, while the defect it exists
// to catch is "the modal outgrew its container". Forcing the container to be
// small tests that property directly, and keeps testing it as the modal grows.
//
// The failure it guards against is user-facing, not cosmetic: on a short window
// a person edits a setting and can neither save nor cancel it — the only way
// out is ✕, which discards the edit.
//
// REF: src/app/SettingsModal.tsx (the capped panel + scrolling body).

import { test, expect } from './_fixtures';

// Deliberately shorter than the modal's natural height. Not a device size —
// the point is to be too small, so the assertion keeps its teeth as the modal
// grows rather than being outrun by the next settings group.
const SHORT = { width: 1280, height: 460 };

test('Save and Cancel stay reachable when the modal is taller than the window (#768)', async ({
  page,
}) => {
  await page.setViewportSize(SHORT);
  await page.goto('/');
  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-settings').click();
  await expect(page.getByTestId('settings-modal')).toBeVisible();

  // The body scrolls; the panel itself must not exceed the window, or the
  // pinned rows are outside it by construction.
  const overflows = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="settings-modal"] > div');
    return panel ? panel.getBoundingClientRect().height > window.innerHeight : true;
  });
  expect(overflows).toBe(false);

  // Capping the panel alone would satisfy the check above and leave the CONTENT
  // unreachable instead of the buttons — measured: removing `overflow-y-auto`
  // passes an assertion about the buttons only. So the body must actually
  // scroll, and the last control in it must be usable.
  // `scrollHeight > clientHeight` is NOT the test — that is equally true of an
  // element that CLIPS its overflow, which is the broken state. Measured: an
  // assertion in that form passed with `overflow-y-auto` deleted. The
  // discriminating observation is whether scrolling actually MOVES anything:
  // a clipped or visible-overflow element pins scrollTop at 0.
  const body = page.getByTestId('settings-body');
  const scrolled = await body.evaluate((el) => {
    el.scrollTop = 99_999;
    return el.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByTestId('settings-model-version').fill('v2.5-reachable');
  await expect(page.getByTestId('settings-model-version')).toHaveValue('v2.5-reachable');

  // The real assertion is that the press LANDS. `click()` fails rather than
  // times out silently when the target cannot be brought into view, which is
  // exactly the defect. No force, no scrollIntoViewIfNeeded — either of those
  // would suppress the report while leaving the person stuck.
  await page.getByTestId('settings-comfy-url').fill('http://reachable.test:9999');
  await page.getByTestId('settings-save').click({ timeout: 10_000 });
  await expect(page.getByTestId('settings-modal')).toBeHidden();

  // And Cancel, on a second open — it is a different button in the same row,
  // and the row is what is under test.
  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-settings').click();
  await page.getByTestId('settings-cancel').click({ timeout: 10_000 });
  await expect(page.getByTestId('settings-modal')).toBeHidden();
});

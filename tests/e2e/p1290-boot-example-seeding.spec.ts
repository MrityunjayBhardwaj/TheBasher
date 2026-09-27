// #1290 — seeding the examples never stands between a director and their project.
//
// One example is a captured scene several megabytes long. Boot used to await it before resuming
// the project, and for that stretch the editor was interactive over a placeholder graph the
// resume then replaced: an edit made there was lost, and a save found no project. Measured at 4x
// CPU: ~0.85 s of it on every fresh boot (acceptance #4 failed in CI on exactly this).
//
// The example's chunk is held back here for several seconds, so "the project opened before the
// example arrived" and "Home still lists it" are both decided by the ORDER boot does things in,
// not by how fast this machine happens to be.

import { expect, test } from './_fixtures';

const HOLD_MS = 4000;

test('a resume opens its project before the captured example has arrived, and Home still lists it', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let chunkRequestedAt: number | null = null;
  let chunkReleasedAt: number | null = null;
  await page.route(/cameraPathAiWalk/, async (route) => {
    chunkRequestedAt = Date.now();
    await new Promise((r) => setTimeout(r, HOLD_MS));
    chunkReleasedAt = Date.now();
    await route.continue();
  });

  // The fixture resumes the default project; storage is fresh, so every example is missing.
  await page.goto('/');
  await expect(page.getByTestId('project-tab-default')).toBeVisible();
  const openedAt = Date.now();
  expect(chunkRequestedAt, 'boot began seeding the captured example').not.toBeNull();
  expect(
    chunkReleasedAt,
    'the project was current while the example was still held back',
  ).toBeNull();

  // Straight to Home while that example is still on its way: it is listed once it lands, not
  // missing because Home read the list first.
  await page.getByTestId('editor-home-button').click();
  await expect(page.getByTestId('home-view')).toBeVisible();
  await expect(page.getByTestId('home-open-example_camera_path_ai_walk')).toBeVisible({
    timeout: HOLD_MS + 20_000,
  });
  expect(chunkReleasedAt).not.toBeNull();
  console.log(
    `[1290] project current ${openedAt - (chunkRequestedAt ?? openedAt)} ms after the example was requested; ` +
      `the example was held ${HOLD_MS} ms`,
  );
});

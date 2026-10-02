// #1424 — a project that holds an import saved on the old imported-file structure is refused.
//
// Nothing reads such an import any more (no renderer since #1053, no load converter since #1424),
// so opening the project would show a scene with its imports missing. What is checked is what a
// returning user sees on each road a saved project can arrive by: the app says which project and
// which file, says what to do, stays on (or returns to) the startup screen, leaves the editor's
// graph alone, and does not try the same project again on the next start.
//
// The project is a recorded save (`_recordedSave.ts`): no door can make one any more.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { recordedSave, writeRecordedSave } from './_recordedSave';

interface Win {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_route: { getState: () => { view: string } };
  __basher_import_scene_bundle: (bundle: unknown) => Promise<string>;
  __basher_writeOpfsBytes?: unknown;
}

const SAVED = recordedSave('clone-models/textured-quad');
const MESSAGE =
  `"${(SAVED.project as unknown as { name: string }).name}" cannot be opened: it holds an import saved on the old ` +
  `imported-file structure ("${SAVED.file}"), which this version no longer reads. Import the file ` +
  `again in a new project; the edits made on it in this project are not carried over.`;

const oldNodesInEditor = (page: Page) =>
  page.evaluate(
    () =>
      Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).filter((n) =>
        n.type.startsWith('Gltf'),
      ).length,
  );
const lastProjectId = (page: Page) =>
  page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
const projectIds = (page: Page) =>
  page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    return (await boot.listAllProjectMetadata()).map((m: { id: string }) => m.id).sort();
  });

test('resuming a project with an old import: refused by name, back on the startup screen', async ({
  page,
}) => {
  // A deliberate nine-second wait, and a boot that seeds a 4 MB example behind the first screen.
  test.slow();
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as Win).__basher_writeOpfsBytes);
  // The recording really holds the old structure — else the rest proves nothing.
  expect(
    Object.values(SAVED.project.state.nodes).filter((n) => n.type.startsWith('Gltf')).length,
  ).toBeGreaterThan(1);
  await writeRecordedSave(page, SAVED);
  expect(await lastProjectId(page)).toBe(SAVED.project.id);
  await page.reload();

  await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('toast-error')).toContainText(MESSAGE);
  expect(await oldNodesInEditor(page)).toBe(0);
  // Not the project the next start resumes, and still listed so it can be deleted.
  expect(await lastProjectId(page)).toBeNull();
  await expect(page.getByTestId(`home-open-${SAVED.project.id}`)).toBeVisible();

  // The message stays until dismissed: it is the only thing saying why the project did not open.
  await page.waitForTimeout(9_000);
  await expect(page.getByTestId('toast-error')).toContainText(MESSAGE);

  // Opening it from the startup screen: the same answer, and the editor does not open.
  await page.getByTestId('toast-dismiss').click();
  await expect(page.getByTestId('toast-error')).toHaveCount(0);
  await page.getByTestId(`home-open-${SAVED.project.id}`).click();
  await expect(page.getByTestId('toast-error')).toContainText(MESSAGE);
  await expect(page.getByTestId('home-view')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Win).__basher_route.getState().view)).toBe(
    'home',
  );
  expect(await lastProjectId(page)).toBeNull();
  expect(await oldNodesInEditor(page)).toBe(0);
});

test('opening a .basher file with an old import: refused, and nothing is written', async ({
  page,
}) => {
  // A deliberate nine-second wait, and a boot that seeds a 4 MB example behind the first screen.
  test.slow();
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as Win).__basher_import_scene_bundle);
  // Boot seeds the examples behind the first screen; the count is taken once they are all there.
  await expect
    .poll(async () => (await projectIds(page)).filter((id) => id.startsWith('example_')).length, {
      timeout: 30_000,
    })
    .toBe(3);
  const before = await projectIds(page);
  const project = SAVED.project as unknown as { formatVersion: number; name: string };
  const rejected = await page.evaluate(
    (bundle) =>
      (window as unknown as Win).__basher_import_scene_bundle(bundle).then(
        () => null,
        (e: Error) => e.message,
      ),
    {
      formatVersion: project.formatVersion,
      bundleVersion: 1,
      id: SAVED.project.id,
      name: project.name,
      exportedAt: 0,
      state: SAVED.project.state,
    },
  );
  expect(rejected).toBe(MESSAGE);
  expect(await projectIds(page)).toEqual(before);
  expect(await oldNodesInEditor(page)).toBe(0);
});

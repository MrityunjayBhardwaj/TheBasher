// #1122 — a motion's stand-in Object reads as its clip until a director names it otherwise.
//
// Driven through the director's own gestures, because the road that matters most is one no
// unit row can take: the inspector's name field commits a `setParam` whose path is a runtime
// variable, and the name then has to reach surfaces that read `meta.name` directly rather than
// through the resolver — the outliner rename box's seed and the viewport's selection summary
// among them. Import goes through the ingest seam (setup only; it appends `.bvh`, so it is
// passed the stem), and every observation after it is a gesture and what the page shows.
//
// Measured on `main` before this change, with the same gestures: the clip read `hero walk`,
// the Object's row still read `soma-walk`, and its rename box opened on `soma-walk`.

import { test, expect, type Page } from './_fixtures';

interface DagNode {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
  meta?: { name?: string; nameFrom?: string };
}
interface Win {
  __basher_dag: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_selection: { getState: () => { select: (id: string) => void } };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Win;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_ingestBvhFile);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await ready(page);
});

/** Rename the clip the way a director does: select it, type in the inspector's name field. */
async function renameClip(page: Page, clipId: string, name: string): Promise<void> {
  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    clipId,
  );
  const field = page.getByTestId(`inspector-text-${clipId}-name`);
  await expect(field).toBeVisible({ timeout: 5_000 });
  await field.fill(name);
  await field.press('Enter');
}

test('the Object follows its clip’s name, keeps a name the director gives it, and undo resumes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|GPU/i.test(m.text())) errors.push(m.text());
  });

  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/anim/soma-walk.bvh')).arrayBuffer());
    await (window as unknown as Win).__basher_ingestBvhFile!(bytes, 'soma-walk'); // appends .bvh
  });
  const ids = await page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    const ref = (v: unknown) => (v as { node?: string } | undefined)?.node;
    const object = Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && nodes[ref(n.inputs.data) ?? '']?.type === 'Skeleton',
    )?.[0];
    const skeleton = object ? ref(nodes[object].inputs.data) : undefined;
    const clip = Object.entries(nodes).find(
      ([, n]) => n.type === 'AnimationClip' && ref(n.inputs.skeleton) === skeleton,
    )?.[0];
    return { object, clip };
  });
  expect(ids.object, 'the import stood no Object — every read below would be vacuous').toBeTruthy();
  expect(ids.clip, 'no clip found for the Object’s skeleton').toBeTruthy();
  const row = page.getByTestId(`scene-tree-row-${ids.object}`);
  await expect(row).toHaveText('soma-walk', { timeout: 5_000 });

  // 1. The clip is renamed in the inspector → the Object's row follows.
  await renameClip(page, ids.clip!, 'hero walk');
  await expect(row).toHaveText('hero walk');

  // 2. Surfaces that read the stored name directly agree: the selection summary …
  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    ids.object!,
  );
  await expect(page.locator('main[aria-label^="3D viewport"]')).toHaveAttribute(
    'aria-label',
    '3D viewport — Object "hero walk"',
  );
  // … and the rename box opens on the name the row shows, not the one it was imported with.
  await row.dblclick();
  const box = page.getByTestId(`scene-tree-rename-${ids.object}`);
  await expect(box).toHaveValue('hero walk');

  // 3. The director names the Object → the clip's next rename leaves it alone.
  await box.fill('my rig');
  await box.press('Enter');
  await expect(row).toHaveText('my rig');
  await renameClip(page, ids.clip!, 'jog');
  await expect(row).toHaveText('my rig');

  // 4. Undo back past the Object's rename → it reads as the clip again, and follows again.
  //    Counted by STATE, not by presses: how many entries a gesture writes belongs to the field
  //    that took it (it once wrote two for Enter then blur, #1127), so a fixed number of presses
  //    would measure that field rather than this behaviour.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 4 && (await row.innerText()) === 'my rig'; i++) {
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(150);
  }
  await expect(row).toHaveText('hero walk');
  const clipName = await page.evaluate(
    (id) =>
      (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.name as string,
    ids.clip!,
  );
  expect(clipName, 'undo went past the clip’s first rename').toBe('hero walk');
  await renameClip(page, ids.clip!, 'run');
  await expect(row).toHaveText('run');

  // 5. Saved and reloaded, the link is still there.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(row).toHaveText('run', { timeout: 10_000 });
  await renameClip(page, ids.clip!, 'sprint');
  await expect(row).toHaveText('sprint');

  expect(errors).toEqual([]);
});

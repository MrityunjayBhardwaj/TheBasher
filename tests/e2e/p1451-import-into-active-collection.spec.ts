// #1451 — where Blender puts an import, through the product's own doors. A collection made with the
// outliner's New Collection and clicked active; then a character picked with File ▸ Import glTF… and
// a motion picked with File ▸ Import Folder…, which binds onto it. Every Object both files make is
// linked into the active collection and still stands in the scene — a collection is membership,
// never a parent (Blender: `io_scene_gltf2/blender/imp/vnode.py:162-163`, `io_anim_bvh/import_bvh.py`
// link each object into the active collection). The bind hides the motion's own rig, which the
// outliner's eye on its row brings back; the collection's eye hides all of it. A save and reload
// keeps the collection, its members, the active choice and what is hidden.
//
// The motion is #1213's two-joint swing, named as the bar's bones, so the bind bridges it by name.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

const SWING_BVH = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

interface Node {
  type: string;
  params: Record<string, unknown>;
  meta?: { name?: string; hidden?: boolean };
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
    };
  };
  __basher_armature?: { skeletonObjects: { id: string }[] };
}

/** The scene's collections, each with its members, and the scene's children and active collection. */
const sceneState = (page: Page) =>
  page.evaluate(() => {
    const { nodes, outputs } = (window as unknown as W).__basher_dag.getState().state;
    const refs = (v: unknown) =>
      (Array.isArray(v) ? v : v ? [v] : []).map((r: { node: string }) => r.node);
    const scene = nodes[outputs.scene!.node];
    return {
      active: (scene.params.activeCollection as string | undefined) ?? null,
      children: refs(scene.inputs.children),
      collections: refs(scene.inputs.collections).map((id) => ({
        id,
        name: nodes[id].meta?.name ?? null,
        hidden: nodes[id].meta?.hidden === true,
        members: refs(nodes[id].inputs.members),
      })),
      objects: Object.entries(nodes)
        .filter(([, n]) => n.type === 'Object' || n.type === 'Group')
        .map(([id, n]) => ({
          id,
          type: n.type,
          hidden: n.meta?.hidden === true,
          rig: nodes[refs(n.inputs.data)[0]]?.type === 'Skeleton',
        })),
    };
  });

/** The armature Objects the bone overlay draws. */
const drawnRigs = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as W).__basher_armature?.skeletonObjects ?? []).map((o) => o.id).sort(),
  );

const retargets = (page: Page) =>
  page.evaluate(
    () =>
      Object.values((window as unknown as W).__basher_dag.getState().state.nodes).filter(
        (n) => n.type === 'RetargetClip',
      ).length,
  );

async function pick(page: Page, item: string, files: string): Promise<void> {
  await page.getByTestId('menu-file-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId(item).click(),
  ]);
  await chooser.setFiles(files);
}

test('#1451 — imports link into the active collection, stand in the scene, and a bind hides only the rig', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebGL|GPU/i.test(m.text())) errors.push(m.text());
  });
  const folder = testInfo.outputPath('swing');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'swing.bvh'), SWING_BVH);

  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  const before = new Set((await sceneState(page)).objects.map((o) => o.id));

  // New Collection from the outliner's menu, then a click makes it active.
  const sceneRow = page.locator('[data-testid^="scene-tree-row-"][data-depth="0"]');
  await sceneRow.click({ button: 'right' });
  await page.getByTestId('outliner-ctx-new-collection').click();
  await expect.poll(async () => (await sceneState(page)).collections.length).toBe(1);
  const [made] = (await sceneState(page)).collections;
  expect(made.name).toBe('Collection');
  await page.getByTestId(`scene-tree-row-${made.id}`).click();
  await expect.poll(async () => (await sceneState(page)).active).toBe(made.id);
  await expect(page.getByTestId(`scene-tree-row-${made.id}`)).toHaveAttribute(
    'data-active-collection',
    'true',
  );

  // The character, then the motion that binds onto it.
  await pick(page, 'menu-file-import-gltf', 'public/assets/skinned-bar.glb');
  await expect.poll(async () => (await drawnRigs(page)).length, { timeout: 15_000 }).toBe(1);
  const [characterRig] = await drawnRigs(page);
  await pick(page, 'menu-file-import', folder);
  await expect.poll(() => retargets(page), { message: 'the bind took', timeout: 15_000 }).toBe(1);

  const landed = await sceneState(page);
  const imported = landed.objects.filter((o) => !before.has(o.id));
  const motionRig = imported.find((o) => o.rig && o.id !== characterRig)!;
  expect(motionRig, 'the motion stood its rig').toBeDefined();
  // Every Object both files made is a member of the active collection, and none is anything's
  // child by being one: each one the file hangs at its root is still the scene's own child.
  expect([...landed.collections[0].members].sort()).toEqual(imported.map((o) => o.id).sort());
  expect(landed.children).toContain(motionRig.id);
  // Neither file wrapped what it made in a Group: there is no transform between them and the scene.
  expect(imported.filter((o) => o.type === 'Group').map((o) => o.id)).toEqual([]);
  // The bind hides the motion's rig itself, and only it.
  expect(imported.filter((o) => o.hidden).map((o) => o.id)).toEqual([motionRig.id]);
  await expect
    .poll(() => drawnRigs(page), { message: 'only the character draws' })
    .toEqual([characterRig]);
  // Its row sits under the collection, with an eye that shows it hidden.
  await expect(page.getByTestId(`scene-tree-eye-${motionRig.id}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  // Saved and reloaded, all of it is as it was left.
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => (await sceneState(page)).collections.length, { timeout: 15_000 })
    .toBe(1);
  const reloaded = await sceneState(page);
  expect(reloaded.active, 'after a reload').toBe(made.id);
  expect([...reloaded.collections[0].members].sort()).toEqual(imported.map((o) => o.id).sort());
  expect(reloaded.objects.find((o) => o.id === motionRig.id)!.hidden).toBe(true);
  await expect
    .poll(() => drawnRigs(page), { message: 'after a reload, only the character draws' })
    .toEqual([characterRig]);

  // The rig's own eye brings it back; the collection's eye hides everything in it.
  await page.getByTestId(`scene-tree-eye-${motionRig.id}`).click();
  await expect
    .poll(() => drawnRigs(page), { message: 'unhidden, the motion’s rig draws again' })
    .toEqual([characterRig, motionRig.id].sort());
  await page.getByTestId(`scene-tree-eye-${made.id}`).click();
  await expect.poll(() => drawnRigs(page), { message: 'the collection hidden' }).toEqual([]);
  expect(errors).toEqual([]);
});

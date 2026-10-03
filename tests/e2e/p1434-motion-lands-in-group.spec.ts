// #1434 — every import lands in an import Group, a motion too (user decision on #1434). Through the
// product's own doors: a character picked with File ▸ Import glTF…, then a motion picked with File ▸
// Import Folder…, which binds onto it. The motion's Group holds only its rig, so the bind hides the
// GROUP — the viewport and the outliner's eye act on top-level nodes — and the rig's bones go with it
// (#1450). The eye on that Group brings the rig back, and a save and reload keeps it as it was left.
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

/** The scene's top-level Groups, each with what it holds, its hidden flag and its children's. */
const sceneGroups = (page: Page) =>
  page.evaluate(() => {
    const { nodes, outputs } = (window as unknown as W).__basher_dag.getState().state;
    const refs = (v: unknown) =>
      (Array.isArray(v) ? v : v ? [v] : []).map((r: { node: string }) => r.node);
    return refs(nodes[outputs.scene!.node].inputs.children)
      .filter((id) => nodes[id].type === 'Group')
      .map((id) => ({
        id,
        hidden: nodes[id].meta?.hidden === true,
        children: refs(nodes[id].inputs.children).map((c) => ({
          id: c,
          name: nodes[c].meta?.name ?? null,
          hidden: nodes[c].meta?.hidden === true,
        })),
      }));
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

test('#1434 — a motion lands in its own Group, and a bind onto a character hides that Group', async ({
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

  // The character: its own Group, its rig drawn.
  await pick(page, 'menu-file-import-gltf', 'public/assets/skinned-bar.glb');
  await expect.poll(async () => (await sceneGroups(page)).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await drawnRigs(page)).length, { timeout: 15_000 }).toBe(1);
  const [characterRig] = await drawnRigs(page);
  const [character] = await sceneGroups(page);

  // The motion: a Group of its own holding its rig alone, which the bind hides.
  await pick(page, 'menu-file-import', folder);
  await expect.poll(async () => (await sceneGroups(page)).length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => retargets(page), { message: 'the bind took', timeout: 15_000 }).toBe(1);
  const motionGroup = () => sceneGroups(page).then((g) => g.find((x) => x.id !== character.id)!);
  const motion = await motionGroup();
  expect(motion.children, 'the motion’s Group holds its rig alone').toEqual([
    { id: motion.children[0].id, name: 'swing', hidden: false },
  ]);
  expect(motion.hidden, 'the bind hides the motion’s Group').toBe(true);
  expect((await sceneGroups(page)).find((g) => g.id === character.id)!.hidden).toBe(false);
  await expect
    .poll(() => drawnRigs(page), { message: 'only the character draws' })
    .toEqual([characterRig]);
  await expect(page.getByTestId(`scene-tree-eye-${motion.id}`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  // Saved and reloaded, it is as it was left.
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await sceneGroups(page)).length, { timeout: 15_000 }).toBe(2);
  expect((await motionGroup()).hidden, 'after a reload').toBe(true);
  await expect
    .poll(() => drawnRigs(page), { message: 'after a reload, only the character draws' })
    .toEqual([characterRig]);

  // The eye on the motion's Group, where the director looks, brings the rig back.
  await page.getByTestId(`scene-tree-eye-${motion.id}`).click();
  expect((await motionGroup()).hidden).toBe(false);
  await expect
    .poll(() => drawnRigs(page), { message: 'unhidden, the motion’s rig draws again' })
    .toEqual([characterRig, motion.children[0].id].sort());
  expect(errors).toEqual([]);
});

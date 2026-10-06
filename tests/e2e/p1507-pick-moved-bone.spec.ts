// #1507 — a bone that has moved outside where the rig first stood can still be clicked.
//
// three tests a click against the bone mesh's bounding sphere before any bone, and computes it only
// once. So: click the armature's bone (the sphere is measured around a one-unit bone), grow the
// chain up to y = 3 with the agent's verb, and click the middle of the new top link, well outside
// that first sphere. Before the fix the click picked nothing and deselected the armature.

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect } from './_fixtures';

interface W {
  __basher_bone: { getState: () => { boneName: string | null } };
  __basher_armature?: { names: string[]; matrices: number[][] };
  __basher_three: {
    getState: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => void };
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: { set: (x: number, y: number, z: number) => void } | null;
    };
  };
}

async function clickBone(page: Page, name: string) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const box = (await page.locator('canvas').first().boundingBox())!;
  const d = await page.evaluate(() => {
    const w = window as unknown as W;
    const cam = w.__basher_three.getState().camera;
    return {
      names: w.__basher_armature!.names,
      matrices: w.__basher_armature!.matrices,
      proj: [...cam.projectionMatrix.elements],
      view: [...cam.matrixWorldInverse.elements],
    };
  });
  const e = d.matrices[d.names.indexOf(name)];
  const ndc = new THREE.Vector3(e[12], e[13], e[14])
    .add(new THREE.Vector3(e[4], e[5], e[6]).multiplyScalar(0.5))
    .applyMatrix4(
      new THREE.Matrix4().multiplyMatrices(
        new THREE.Matrix4().fromArray(d.proj),
        new THREE.Matrix4().fromArray(d.view),
      ),
    );
  await page.mouse.click(
    box.x + ((ndc.x + 1) / 2) * box.width,
    box.y + ((1 - ndc.y) / 2) * box.height,
  );
}
const picked = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_bone.getState().boneName);

test('#1507 — a bone grown past where the rig first stood is still picked by a click', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const id = await page.evaluate(async () => {
    const w = window as unknown as W;
    w.__basher_three.getState().controlsTarget!.set(0, 0, 0);
    const add = await import('/src/app/AddMenu.tsx');
    add.addPrimitive('Armature');
    const s = await import('/src/app/stores/selectionStore.ts');
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const armature = s.useSelectionStore.getState().primaryNodeId!;
    modes.useArmatureModeStore.getState().setMode(armature, 'pose');
    return armature;
  });
  // Framed after the add settles (adding re-aims the view), from the side, on where the chain grows.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        const t = (window as unknown as W).__basher_three.getState();
        t.controlsTarget!.set(0, 1.5, 0);
        t.camera.position.set(0, 1.5, 6);
      });
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const e = (window as unknown as W).__basher_three.getState().camera.matrixWorldInverse
          .elements;
        return Math.round(e[13] * 100) / 100;
      });
    })
    .toBe(-1.5);

  // The first click measures the sphere around the one-unit bone.
  await clickBone(page, 'Bone');
  await expect.poll(() => picked(page)).toBe('Bone');

  // Grow the chain to y = 3.
  await page.evaluate(async (object) => {
    const d = await import('/src/app/animate/dispatchMutator.ts');
    for (const from of ['Bone_end', 'Bone_end_001']) {
      const r = d.dispatchMutatorFromUI(
        'mutator.rig.editSkeleton',
        { object, edit: { op: 'extrude', from } },
        'grow',
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
  }, id);

  // The top link (y 2 → 3) lies outside the first sphere; it must still pick.
  await clickBone(page, 'Bone_end_001');
  await expect.poll(() => picked(page)).toBe('Bone_end_001');
  await expect(page.getByTestId(`scene-tree-row-${id}`)).toHaveAttribute('data-active', 'true');
});

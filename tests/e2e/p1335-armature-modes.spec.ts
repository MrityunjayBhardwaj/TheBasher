// #1335 — Object, Edit and Pose modes for an armature: what a click picks in each, the rest pose
// drawn in Edit, and no node in the graph touched by any switch.
//
// The rig is the skinned bar (two bones, Bone0 → Bone1), imported through the product's native
// reader. Its clip keys Bone1 from 0 to ~85° about Z, so at 0.9 s the drawn Bone1 is far from its
// rest direction, which is what tells "Edit draws the rest" from "Edit draws the pose". The rest
// direction is read where the clip is at 0°, frame 0.
//
// Clicks are AIMED at a bone's midpoint, computed from the matrices the helper publishes, as
// `bone-selection.spec.ts` does.

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect, settleViewFit } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_bone: { getState: () => { boneName: string | null } };
  __basher_armature_mode: { get: () => string };
  __basher_armature?: { names: string[]; matrices: number[][]; highlightedBone: string | null };
  __basher_three: {
    getState: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => void };
        projectionMatrix: { elements: number[] };
        matrixWorldInverse: { elements: number[] };
      };
      controlsTarget: { set: (x: number, y: number, z: number) => void };
    };
  };
}

async function importBar(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  // #1523 — this spec writes the camera by hand: wait out the boot view fit, which would land after.
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  await page.waitForFunction(() => Boolean((window as unknown as W).__basher_armature_mode));
  const id = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1335/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    return (nodes[modifier].inputs.armature as { node: string }).node;
  });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_time.getState().setTime(0.9);
    const t = w.__basher_three.getState();
    t.controlsTarget.set(0, 1, 0);
    t.camera.position.set(0, 1, 5);
  });
  // Selected from the outliner, so the setup does not depend on the click under test.
  await page.getByTestId(`scene-tree-row-${id}`).click();
  await expect(page.getByTestId('armature-mode')).toBeVisible();
  return id;
}

/** The drawn bone `name`: its page-space midpoint and its head→tail direction. */
async function drawnBone(page: Page, name: string) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const box = (await page.locator('canvas').first().boundingBox())!;
  const d = await page.evaluate(() => {
    const w = window as unknown as W;
    const cam = w.__basher_three.getState().camera;
    return {
      names: w.__basher_armature?.names ?? [],
      matrices: w.__basher_armature?.matrices ?? [],
      proj: [...cam.projectionMatrix.elements],
      view: [...cam.matrixWorldInverse.elements],
    };
  });
  const i = d.names.indexOf(name);
  expect(i, `${name} is drawn`).toBeGreaterThanOrEqual(0);
  const e = d.matrices[i];
  const head = new THREE.Vector3(e[12], e[13], e[14]);
  const axis = new THREE.Vector3(e[4], e[5], e[6]);
  const ndc = head
    .clone()
    .add(axis.clone().multiplyScalar(0.5))
    .applyMatrix4(
      new THREE.Matrix4().multiplyMatrices(
        new THREE.Matrix4().fromArray(d.proj),
        new THREE.Matrix4().fromArray(d.view),
      ),
    );
  return {
    x: box.x + ((ndc.x + 1) / 2) * box.width,
    y: box.y + ((1 - ndc.y) / 2) * box.height,
    dir: axis.normalize(),
  };
}

const graph = (page: Page) =>
  page.evaluate(() => JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes));
const mode = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_armature_mode.get());
const pickedBone = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_bone.getState().boneName);
const highlighted = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_armature?.highlightedBone ?? null);

test('Object → Pose → Edit → Object: what a click picks in each, and the graph untouched', async ({
  page,
}) => {
  const armature = await importBar(page);
  const before = await graph(page);
  const menu = page.getByTestId('armature-mode');
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0));
  const REST_DIR = (await drawnBone(page, 'Bone1')).dir;
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.9));

  // OBJECT: a click on a bone selects the armature, never the bone.
  await expect(menu).toHaveValue('object');
  let b1 = await drawnBone(page, 'Bone1');
  await page.mouse.click(b1.x, b1.y);
  await page.waitForTimeout(200);
  expect(await pickedBone(page), 'object mode picked a bone').toBeNull();
  await expect(page.getByTestId(`scene-tree-row-${armature}`)).toHaveAttribute(
    'data-active',
    'true',
  );

  // POSE: the same click picks the bone, lights it and names it; the bones are drawn posed.
  await menu.selectOption('pose');
  expect(await mode(page)).toBe('pose');
  expect(b1.dir.dot(REST_DIR), 'at 0.9 s the clip has turned Bone1 off its rest').toBeLessThan(0.5);
  await page.mouse.click(b1.x, b1.y);
  await expect.poll(() => pickedBone(page)).toBe('Bone1');
  // The highlight is published by the viewport's next frame, which a slow renderer has not run yet
  // when the selection lands (#1523: read at once, it was still null under software GL).
  await expect.poll(() => highlighted(page)).toBe('Bone1');
  await expect(page.getByTestId('inspector-selected-bone-name')).toHaveValue('Bone1');

  // EDIT (Tab): the rest bones are drawn, and a bone is still what a click picks.
  await page.mouse.move(10, 450);
  await page.keyboard.press('Tab');
  await expect(menu).toHaveValue('edit');
  b1 = await drawnBone(page, 'Bone1');
  expect(b1.dir.dot(REST_DIR), 'edit mode draws Bone1 at its rest direction').toBeGreaterThan(
    0.999,
  );
  const b0 = await drawnBone(page, 'Bone0');
  await page.mouse.click(b0.x, b0.y);
  await expect.poll(() => pickedBone(page)).toBe('Bone0');
  await expect.poll(() => highlighted(page)).toBe('Bone0');

  // OBJECT (Tab again): no bone is live, nothing is lit, the bones are posed again.
  await page.keyboard.press('Tab');
  await expect(menu).toHaveValue('object');
  await expect(page.getByTestId('inspector-selected-bone')).toHaveCount(0);
  await expect.poll(() => highlighted(page)).toBeNull();
  expect((await drawnBone(page, 'Bone1')).dir.dot(REST_DIR)).toBeLessThan(0.5);

  expect(await graph(page), 'a mode switch wrote to the graph').toBe(before);
});

test('Ctrl+Tab toggles Pose mode, and Tab from Pose goes to Edit', async ({ page }) => {
  await importBar(page);
  await page.mouse.move(10, 450);
  // Playwright delivers Ctrl+Tab to the page; Chrome itself keeps it for tab switching, which
  // is why the mode menu exists.
  await page.keyboard.press('Control+Tab');
  expect(await mode(page)).toBe('pose');
  await page.keyboard.press('Tab');
  expect(await mode(page)).toBe('edit');
  await page.keyboard.press('Control+Tab');
  expect(await mode(page)).toBe('pose');
  await page.keyboard.press('Control+Tab');
  expect(await mode(page)).toBe('object');
});

test('with a non-armature selected, Tab keeps its other meaning and there is no mode menu', async ({
  page,
}) => {
  const armature = await importBar(page);
  await page.getByTestId('armature-mode').selectOption('pose');
  // Selecting a cube leaves the armature's mode: the mode belongs to the thing being worked on.
  const box = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'Object' &&
        nodes[(n.inputs.data as { node?: string } | undefined)?.node ?? '']?.type === 'BoxData',
    )![0];
  });
  await page.getByTestId(`scene-tree-row-${box}`).click();
  await expect(page.getByTestId('armature-mode')).toHaveCount(0);
  expect(await mode(page)).toBe('object');

  await page.mouse.move(10, 450);
  await expect(page.getByTestId('toolbar-space-uv')).not.toHaveClass(/text-accent/);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('toolbar-space-uv')).toHaveClass(/text-accent/);
  void armature;
});

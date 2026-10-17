// #1611 — with the Light Brush on, a click that lands on a bone paints the light on the skin behind.
//
// A character's bones are drawn through its body and pick in front of it, so a click on the chest
// or face often lands on a bone first. That click used to select the armature: the light lost the
// selection, and the brush stayed switched on with nothing to paint.
//
// Each test first makes the same click with the brush OFF and requires it to select the thing in
// front (the armature, the camera). That is what proves the click lands on a helper at all; the
// brush-on click is then made at the same pixel.
//
// REF: src/viewport/selectNodeOnClick.ts (`selectNode`); src/viewport/ArmatureHelper.tsx
//      (`onBoneClick`); src/viewport/SceneFromDAG.tsx (the brush branch of the mesh click).

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect, settleViewFit } from './_fixtures';
import { splitLightOps } from './_splitLight';

interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_selection: {
    getState: () => { primaryNodeId: string | null; select: (id: string) => void };
  };
  __basher_armature?: { names: string[]; matrices: number[][] };
  __basher_gltf_skin?: () => unknown;
  __basher_frustum_pose?: Record<string, { position: [number, number, number] }>;
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

type Vec3 = [number, number, number];
const LIGHT = 'p1611_light';
const START: Vec3 = [6, 0, 0];

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
const selected = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId);
const select = (page: Page, id: string) =>
  page.evaluate((id) => (window as unknown as W).__basher_selection.getState().select(id), id);
const lightPos = (page: Page) =>
  page.evaluate(
    (id) =>
      (window as unknown as W).__basher_dag.getState().state.nodes[id].params.position as Vec3,
    LIGHT,
  );

/** Where a world point is drawn, in page pixels; and that the canvas is what lies under it. */
async function screenOf(page: Page, at: Vec3) {
  await frames(page);
  const box = (await page.locator('[data-testid="viewport"] canvas').first().boundingBox())!;
  const d = await page.evaluate(() => {
    const cam = (window as unknown as W).__basher_three.getState().camera;
    return { proj: [...cam.projectionMatrix.elements], view: [...cam.matrixWorldInverse.elements] };
  });
  const ndc = new THREE.Vector3(...at).applyMatrix4(
    new THREE.Matrix4().multiplyMatrices(
      new THREE.Matrix4().fromArray(d.proj),
      new THREE.Matrix4().fromArray(d.view),
    ),
  );
  const pt = {
    x: box.x + ((ndc.x + 1) / 2) * box.width,
    y: box.y + ((1 - ndc.y) / 2) * box.height,
  };
  // A panel over the viewport would take the click instead, and every assertion below would
  // then be about the panel.
  const onCanvas = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS',
    pt,
  );
  expect(
    onCanvas,
    `the click point (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)}) is on the canvas`,
  ).toBe(true);
  return pt;
}

/** Aim the editor camera by hand and wait until the view has taken it. */
async function frame(page: Page, target: Vec3, from: Vec3) {
  await expect
    .poll(async () => {
      await page.evaluate(
        ({ target, from }) => {
          const t = (window as unknown as W).__basher_three.getState();
          t.controlsTarget!.set(...target);
          t.camera.position.set(...from);
        },
        { target, from },
      );
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const e = (window as unknown as W).__basher_three.getState().camera.matrixWorldInverse
          .elements;
        // The camera's own position, back out of the view matrix.
        const m = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
        const p = [
          -(m[0] * e[12] + m[1] * e[13] + m[2] * e[14]),
          -(m[3] * e[12] + m[4] * e[13] + m[5] * e[14]),
          -(m[6] * e[12] + m[7] * e[13] + m[8] * e[14]),
        ];
        // `|| 0` folds a negative zero, which deep equality tells apart from zero.
        return p.map((v) => Math.round(v * 100) / 100 || 0);
      });
    })
    .toEqual(from);
}

/** A rig light the brush can paint: an Area light aimed at the origin by a Track-To. */
async function addRigLight(page: Page) {
  const lightOps = splitLightOps({
    objectId: LIGHT,
    lightKind: 'Area',
    position: START,
    shading: { intensity: 5, color: '#ffffff', width: 2, height: 2, lookAt: [0, 0, 0] },
  });
  await page.evaluate(
    ({ id, lightOps }) => {
      const dag = (window as unknown as W).__basher_dag.getState();
      dag.dispatchAtomic(
        [
          ...lightOps,
          {
            type: 'connect',
            from: { node: id, socket: 'out' },
            to: { node: dag.state.outputs.scene!.node, socket: 'lights' },
          },
          {
            type: 'addNode',
            nodeId: `${id}_tt`,
            nodeType: 'TrackTo',
            params: { target: id, aimNode: '', aimPoint: [0, 0, 0], up: [0, 1, 0], mute: false },
          },
        ],
        'e2e',
        'add rig light',
      );
    },
    { id: LIGHT, lightOps },
  );
}

async function setBrush(page: Page, on: boolean) {
  if ((await page.getByTestId('timeline-drawer').getAttribute('data-open')) !== 'true')
    await page.getByTestId('timeline-drawer-toggle').click();
  await page.getByTestId('timeline-tab-lightStudio').click();
  const toggle = page.getByTestId('light-studio-brush-toggle');
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  // These specs write the camera by hand: wait out the boot view fit, which would land after.
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await addRigLight(page);
});

test('#1611 — brush on, a click on a bone paints the light on the skin behind it', async ({
  page,
}) => {
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const d = await import('/src/app/animate/dispatchMutator.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1611/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    // The starter cube stands where the character does. The ARMATURE stays shown: its bones
    // drawn over the skin are the subject.
    const r = d.dispatchMutatorFromUI(
      'mutator.setHidden',
      { targetSelectors: ['n_box'], hidden: true },
      'hide',
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    return (nodes[modifier].inputs.armature as { node: string }).node;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the character is drawn skinned',
      timeout: 15_000,
    })
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_armature?.names.length ?? 0))
    .toBeGreaterThan(0);

  // The middle of the first drawn bone, which lies inside the bar.
  const onBone = await page.evaluate(() => {
    const e = (window as unknown as W).__basher_armature!.matrices[0];
    return [e[12] + e[4] / 2, e[13] + e[5] / 2, e[14] + e[6] / 2] as [number, number, number];
  });
  // Framed so the bar sits in the top of the viewport, clear of the Light Studio drawer.
  await setBrush(page, false);
  await frame(page, [onBone[0], onBone[1] - 2.5, onBone[2]], [onBone[0], onBone[1] - 2.5, 10]);
  const pt = await screenOf(page, onBone);

  // Brush OFF: the click lands on the bone, and a bone click selects the armature.
  await select(page, LIGHT);
  await page.mouse.click(pt.x, pt.y);
  await expect
    .poll(() => selected(page), { message: 'the click point is on a bone' })
    .toBe(armature);
  expect(await lightPos(page), 'a plain click paints nothing').toEqual(START);

  // Brush ON, the same pixel.
  await select(page, LIGHT);
  await setBrush(page, true);
  await page.mouse.click(pt.x, pt.y);

  await expect
    .poll(() => lightPos(page), { message: 'the stroke went through the bone' })
    .not.toEqual(START);
  expect(Math.hypot(...(await lightPos(page))), 'the light stays on its own shell').toBeCloseTo(
    6,
    3,
  );
  expect(await selected(page), 'the light is still selected').toBe(LIGHT);

  // The brush is still live: a second stroke from another angle moves the light again.
  const first = await lightPos(page);
  await frame(page, [onBone[0], onBone[1] - 2.5, onBone[2]], [onBone[0] + 6, onBone[1] - 2.5, 8]);
  const again = await screenOf(page, onBone);
  await page.mouse.click(again.x, again.y);
  await expect
    .poll(() => lightPos(page), { message: 'the second stroke paints too' })
    .not.toEqual(first);
  expect(await selected(page)).toBe(LIGHT);
});

test('#1611 — brush on, a click on a camera helper does not take the selection from the light', async ({
  page,
}) => {
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_frustum_pose?.n_camera),
  );
  const cam = await page.evaluate(
    () => (window as unknown as W).__basher_frustum_pose!.n_camera.position,
  );
  await setBrush(page, false);
  await frame(page, [cam[0], cam[1] - 1.5, cam[2]], [cam[0] + 5, cam[1] - 1.5, cam[2] + 5]);
  const pt = await screenOf(page, cam);

  // Brush OFF: the click lands on the camera's helper and selects the camera.
  await select(page, LIGHT);
  await page.mouse.click(pt.x, pt.y);
  await expect
    .poll(() => selected(page), { message: 'the click point is on the camera helper' })
    .toBe('n_camera');

  await select(page, LIGHT);
  await setBrush(page, true);
  await page.mouse.click(pt.x, pt.y);
  await frames(page);
  expect(await selected(page), 'the light is still selected').toBe(LIGHT);
});

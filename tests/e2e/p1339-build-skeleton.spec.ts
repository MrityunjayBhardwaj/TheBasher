// #1339 — build a skeleton by hand in Edit mode, from nothing, through the UI: Add › Armature, E to
// extrude a three-link chain, subdivide the middle link, re-parent the tip, and the graph and the
// drawn bones agree at every step. Every step undoes to the graph before it exactly.
//
// The armature Add › Armature stands is one bone, `Bone` at the origin with its tail joint `Bone_end`
// a unit up +Y. Extruding continues a chain: the new joint sits as far from its parent, in the same
// direction, as the parent sits from its own — so two extrudes from the tip put joints at y = 2 and
// y = 3. Bones are picked with clicks aimed at the drawn bone's middle (`bone-selection.spec.ts`).

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect, settleViewFit } from './_fixtures';

interface Bone {
  name: string;
  parent: number;
  position: number[];
}
interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
      };
    };
  };
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

const skeletonBones = (page: Page) =>
  page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const skel = Object.values(nodes).find(
      (n) => n.type === 'Skeleton' && (n.params.bones as Bone[])[0]?.name === 'Bone',
    );
    return (skel?.params.bones as Bone[]) ?? [];
  });
const graph = (page: Page) =>
  page.evaluate(() => JSON.stringify((window as unknown as W).__basher_dag.getState().state.nodes));
const picked = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_bone.getState().boneName);

/** The drawn bones: names, and each head in the world. */
async function drawn(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature!;
    return a.names.map((name, i) => ({
      name,
      head: [a.matrices[i][12], a.matrices[i][13], a.matrices[i][14]].map(
        (c) => Math.round(c * 1e4) / 1e4,
      ),
    }));
  });
}

/** Click the middle of the drawn bone `name`. */
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
  const cx = box.x + ((ndc.x + 1) / 2) * box.width;
  const cy = box.y + ((1 - ndc.y) / 2) * box.height;
  // #1523 — an aim off the canvas clicks nothing and reads as "the wrong bone is picked" (the old
  // selection stays). Say what happened instead: the camera is not where this test put it.
  expect(
    Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1,
    `"${name}" is off the canvas at (${cx.toFixed(0)}, ${cy.toFixed(0)}): something moved the camera`,
  ).toBe(true);
  await page.mouse.click(cx, cy);
  await expect.poll(() => picked(page)).toBe(name);
}

test('#1339 — a skeleton built by hand in Edit mode, and every step undone exactly', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );

  // #1523 — the boot view fit keeps writing the camera until it settles (45 still frames). On a slow
  // renderer it was still running when this test framed the chain by hand below, and landed after:
  // the camera ended at the fit's pose, the bone aimed at sat above the canvas, and the click reached
  // nothing. Measured under software GL: camera at (1.88, 1.25, 1.88) instead of (0, 1.5, 6), the
  // click at y = -108 px. Wait for the fit before writing the camera.
  await settleViewFit(page);

  // Add places a new object at the view's orbit target: the origin, so the heads below are the
  // skeleton's own numbers.
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0, 0, 0);
  });
  const graphs = [await graph(page)];

  // From nothing: Add › Armature.
  await page.mouse.move(700, 450);
  await page.keyboard.press('Shift+A');
  await page.getByText('Empty', { exact: true }).hover();
  await page.getByText('Armature', { exact: true }).click();
  await expect(page.getByTestId('armature-mode')).toBeVisible();
  // Framed on where the chain will grow, from the side so every link is long on screen.
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0, 1.5, 0);
    t.camera.position.set(0, 1.5, 6);
  });
  expect((await skeletonBones(page)).map((b) => b.name)).toEqual(['Bone', 'Bone_end']);
  graphs.push(await graph(page));

  // Edit mode, and the tip picked.
  await page.getByTestId('armature-mode').selectOption('edit');
  await clickBone(page, 'Bone');
  await expect(page.getByTestId('edit-bone')).toBeVisible();

  // E twice from the tail joint: a three-link chain. Each extrude selects the new tip.
  await page.evaluate(async () => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    const s = await import('/src/app/stores/selectionStore.ts');
    // Pick the tail joint the way the panel names it: it is a leaf, too short to aim at reliably.
    b.useBoneSelectionStore
      .getState()
      .selectBone(s.useSelectionStore.getState().primaryNodeId!, 'Bone_end', ['Bone', 'Bone_end']);
  });
  await page.mouse.move(10, 450);
  for (const tip of ['Bone_end_001', 'Bone_end_002']) {
    await page.keyboard.press('e');
    await expect.poll(() => picked(page)).toBe(tip);
    graphs.push(await graph(page));
  }
  expect((await skeletonBones(page)).map((b) => [b.name, b.parent])).toEqual([
    ['Bone', -1],
    ['Bone_end', 0],
    ['Bone_end_001', 1],
    ['Bone_end_002', 2],
  ]);
  // The drawn rest bones are the graph's, at the heads the chain rule says.
  expect(await drawn(page)).toEqual([
    { name: 'Bone', head: [0, 0, 0] },
    { name: 'Bone_end', head: [0, 1, 0] },
    { name: 'Bone_end_001', head: [0, 2, 0] },
    { name: 'Bone_end_002', head: [0, 3, 0] },
  ]);

  // Subdivide the middle link (Bone_end → Bone_end_001) from the panel.
  await clickBone(page, 'Bone_end');
  await page.getByTestId('edit-bone-subdivide').click();
  await expect.poll(() => picked(page)).toBe('Bone_end_003');
  graphs.push(await graph(page));
  expect((await skeletonBones(page)).map((b) => [b.name, b.parent])).toEqual([
    ['Bone', -1],
    ['Bone_end', 0],
    ['Bone_end_001', 4],
    ['Bone_end_002', 2],
    ['Bone_end_003', 1],
  ]);
  expect((await drawn(page)).find((b) => b.name === 'Bone_end_003')!.head).toEqual([0, 1.5, 0]);

  // Re-parent the tip to the root from the panel; it stays where it stands.
  await clickBone(page, 'Bone_end_002');
  await page.getByTestId('edit-bone-parent').selectOption('Bone');
  graphs.push(await graph(page));
  const bones = await skeletonBones(page);
  expect(bones.find((b) => b.name === 'Bone_end_002')!.parent).toBe(0);
  expect((await drawn(page)).find((b) => b.name === 'Bone_end_002')!.head).toEqual([0, 3, 0]);

  // Every step undoes to the graph before it, byte for byte.
  await page.mouse.move(10, 450);
  for (let k = graphs.length - 1; k > 0; k--) {
    await page.keyboard.press('Control+z');
    await expect.poll(() => graph(page), { message: `undo to step ${k - 1}` }).toBe(graphs[k - 1]);
  }
});

test('#1339 — the Edit-mode gizmo moves a joint; its children follow, or stay where they are', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await page.evaluate(async () => {
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0);
    const add = await import('/src/app/AddMenu.tsx');
    add.addPrimitive('Armature');
    const s = await import('/src/app/stores/selectionStore.ts');
    const id = s.useSelectionStore.getState().primaryNodeId!;
    const d = await import('/src/app/animate/dispatchMutator.ts');
    d.dispatchMutatorFromUI(
      'mutator.rig.editSkeleton',
      { object: id, edit: { op: 'extrude', from: 'Bone_end' } },
      'grow',
    );
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'edit');
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore.getState().selectBone(id, 'Bone_end', ['Bone', 'Bone_end']);
    const g = await import('/src/app/stores/gizmoStore.ts');
    g.useGizmoStore.getState().setMode('translate');
  });
  await expect(page.getByTestId('edit-bone')).toBeVisible();
  const grab = (to: number[]) =>
    page.evaluate(
      (p) =>
        (
          window as unknown as { __basher_bone_grab: (t: { position: number[] }) => boolean }
        ).__basher_bone_grab({
          position: p,
        }),
      to,
    );
  const head = async (name: string) => (await drawn(page)).find((b) => b.name === name)!.head;

  // Children stay: the joint moves, its child holds where it was.
  await page.getByTestId('edit-bone-children-stay').check();
  await expect.poll(() => head('Bone_end')).toEqual([0, 1, 0]);
  expect(await grab([0.5, 1, 0])).toBe(true);
  await expect.poll(() => head('Bone_end')).toEqual([0.5, 1, 0]);
  expect(await head('Bone_end_001')).toEqual([0, 2, 0]);
  // The rest field shows the joint's new place under its parent.
  await expect(page.getByTestId('edit-bone-position-x')).toHaveValue('0.5');

  // Children follow: the joint and its child move together.
  await page.getByTestId('edit-bone-children-stay').uncheck();
  expect(await grab([0.5, 1.5, 0])).toBe(true);
  await expect.poll(() => head('Bone_end')).toEqual([0.5, 1.5, 0]);
  expect(await head('Bone_end_001')).toEqual([0, 2.5, 0]);

  // X deletes the selected bone; its child goes to its parent and stays where it stands. (The
  // checkbox above keeps focus, and a key typed into a field is the field's.)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('x');
  await expect
    .poll(async () => (await skeletonBones(page)).map((b) => b.name))
    .toEqual(['Bone', 'Bone_end_001']);
  expect((await skeletonBones(page))[1].parent).toBe(0);
  expect(await head('Bone_end_001')).toEqual([0, 2.5, 0]);

  // Alt+P clears the selected bone's parent, keeping it where it stands.
  await page.evaluate(async () => {
    const s = await import('/src/app/stores/selectionStore.ts');
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore
      .getState()
      .selectBone(s.useSelectionStore.getState().primaryNodeId!, 'Bone_end_001', [
        'Bone',
        'Bone_end_001',
      ]);
  });
  await page.keyboard.press('Alt+KeyP');
  await expect.poll(async () => (await skeletonBones(page))[1].parent).toBe(-1);
  expect(await head('Bone_end_001')).toEqual([0, 2.5, 0]);
});

test('#1526 — a second quick extrude keeps its bone selected; undoing it clears the selection', async ({
  page,
}) => {
  // The viewport drops a selected bone the rig no longer has. The canvas is its own React root and
  // can hold the rig one edit behind on a frame, so that is asked of the live graph. Forced here:
  // frames held while the first extrude reaches the canvas, then the second key and one frame
  // straight after it, before the canvas re-renders (CI's slow frames did this on their own).
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await page.evaluate(async () => {
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0);
    const add = await import('/src/app/AddMenu.tsx');
    add.addPrimitive('Armature');
    const s = await import('/src/app/stores/selectionStore.ts');
    const id = s.useSelectionStore.getState().primaryNodeId!;
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'edit');
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore.getState().selectBone(id, 'Bone_end', ['Bone', 'Bone_end']);
  });
  await expect(page.getByTestId('edit-bone')).toBeVisible();
  await page.mouse.move(10, 450);

  type Held = { __q: FrameRequestCallback[]; __raf: typeof requestAnimationFrame };
  await page.evaluate(() => {
    const w = window as unknown as Held;
    w.__q = [];
    w.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => (w.__q.push(cb), 0);
  });
  await page.keyboard.press('e');
  await expect.poll(() => picked(page)).toBe('Bone_end_001');
  await page.waitForTimeout(300);
  const second = await page.evaluate(() => {
    const w = window as unknown as Held & W;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
    const afterKey = w.__basher_bone.getState().boneName;
    const frames = w.__q.splice(0);
    frames.forEach((cb) => cb(performance.now()));
    return { afterKey, afterFrame: w.__basher_bone.getState().boneName, frames: frames.length };
  });
  expect(second.afterKey).toBe('Bone_end_002');
  expect(second.frames, 'a held frame ran after the key').toBeGreaterThan(0);
  expect(second.afterFrame, 'the frame after the key keeps the new bone').toBe('Bone_end_002');
  await page.evaluate(() => {
    const w = window as unknown as Held;
    window.requestAnimationFrame = w.__raf;
    w.__q.splice(0).forEach((cb) => w.__raf(cb));
  });
  await page.waitForTimeout(300);
  expect(await picked(page), 'still selected once frames run freely').toBe('Bone_end_002');

  // A bone that really goes away still clears: undo takes the second extrude back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => (await skeletonBones(page)).map((b) => b.name))
    .toEqual(['Bone', 'Bone_end', 'Bone_end_001']);
  await expect.poll(() => picked(page)).toBeNull();
});

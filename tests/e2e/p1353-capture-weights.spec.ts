// #1353 — a tube and a three-bone chain, both made here, bound from the panel: turning the middle
// bone bends the tube smoothly. No weights are imported — the mesh is stored with none, and the
// only thing that writes any is the Capture the bind adds.
//
// The tube stands on +Y from 0 to 3 at radius 0.25. The chain is Add › Armature (joints at y = 0
// and 1) and one extrude in Edit mode (a third joint at y = 2, drawn 0.25 long). With the default
// capture (4 influences, dropoff 4) a point beside the middle bone, at (0.25, 1.5, 0), is 1/1.08 on
// it and 0.04/1.08 on each neighbour. A quarter turn of the middle bone about Z carries it 26/27 of
// the way to (−0.5, 1.25, 0): (−0.4722, 1.2593, 0).

import type { Page } from '@playwright/test';
import { test, expect, settleViewFit } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_bone: { getState: () => { boneName: string | null } };
  __basher_bone_gizmo?: () => { bone: string | null } | null;
  __basher_bone_grab?: (to: { quaternion?: number[] }) => boolean;
  __basher_gltf_skin?: () => {
    count: number;
    bound: boolean;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
  __basher_three: {
    getState: () => {
      camera: { position: { set: (x: number, y: number, z: number) => void } };
      controlsTarget: { set: (x: number, y: number, z: number) => void } | null;
    };
  };
}

const TUBE = 'p1353_tube';
const TUBE_DATA = 'p1353_tube_data';

const nodes = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_dag.getState().state.nodes);

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Where the drawn vertex that RESTS nearest `at` is now. */
async function drawnAt(page: Page, at: [number, number, number]): Promise<number[]> {
  await frames(page);
  return page.evaluate((target) => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < s.count; i++) {
      const r = s.rest(i);
      const d = Math.hypot(r[0] - target[0], r[1] - target[1], r[2] - target[2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > 1e-4) throw new Error(`no vertex rests at ${target.join(', ')} (nearest ${bestD})`);
    return s.vertex(best);
  }, at);
}

test('#1353 — a tube bound to a chain made in Edit mode bends smoothly, with no imported weights', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await settleViewFit(page);
  await page.evaluate(() =>
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0),
  );

  // The tube: a stored mesh with no weights and no groups, standing at the origin.
  await page.evaluate(
    async ({ tube, data }) => {
      const w = window as unknown as W;
      const { cylinderMesh } = await import('/src/test-utils/cylinderMesh.ts');
      const { packMeshData } = await import('/src/app/meshGeometryData.ts');
      const dag = w.__basher_dag.getState();
      const mesh = packMeshData(cylinderMesh({ radius: 0.25, height: 3, radial: 16, rings: 25 }));
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: data,
            nodeType: 'PolyMeshData',
            params: { mesh, material: null },
          },
          { type: 'addNode', nodeId: tube, nodeType: 'Object', params: {} },
          {
            type: 'connect',
            from: { node: data, socket: 'out' },
            to: { node: tube, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: tube, socket: 'out' },
            to: { node: dag.state.outputs.scene!.node, socket: 'children' },
          },
        ],
        'user',
        'add tube',
      );
    },
    { tube: TUBE, data: TUBE_DATA },
  );
  const stored = (await nodes(page))[TUBE_DATA].params.mesh as {
    pointLayers: unknown[];
    vertexGroups: unknown[];
  };
  expect(stored.pointLayers).toEqual([]);
  expect(stored.vertexGroups).toEqual([]);

  // The chain, by hand: Add › Armature, then one extrude from its tail joint in Edit mode.
  await page.mouse.move(700, 450);
  await page.keyboard.press('Shift+A');
  await page.getByText('Empty', { exact: true }).hover();
  await page.getByText('Armature', { exact: true }).click();
  await expect(page.getByTestId('armature-mode')).toBeVisible();
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0, 1.5, 0);
    t.camera.position.set(0, 1.5, 6);
  });
  await page.getByTestId('armature-mode').selectOption('edit');
  const armature = await page.evaluate(async () => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    const s = await import('/src/app/stores/selectionStore.ts');
    const id = s.useSelectionStore.getState().primaryNodeId!;
    b.useBoneSelectionStore.getState().selectBone(id, 'Bone_end', ['Bone', 'Bone_end']);
    return id;
  });
  await page.mouse.move(10, 450);
  await page.keyboard.press('e');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_bone.getState().boneName))
    .toBe('Bone_end_001');
  const skeleton = Object.values(await nodes(page)).find((n) => n.type === 'Skeleton')!;
  expect(
    (skeleton.params.bones as { name: string; parent: number; position: number[] }[]).map((b) => [
      b.name,
      b.parent,
      b.position,
    ]),
  ).toEqual([
    ['Bone', -1, [0, 0, 0]],
    ['Bone_end', 0, [0, 1, 0]],
    ['Bone_end_001', 1, [0, 1, 0]],
  ]);
  await page.getByTestId('armature-mode').selectOption('object');

  // Bind, from the tube's modifier section.
  await page.evaluate(async (id) => {
    const s = await import('/src/app/stores/selectionStore.ts');
    s.useSelectionStore.getState().select(id);
  }, TUBE);
  await page.getByTestId('inspector-section-toggle-modifier').click();
  const bind = page.getByTestId('skin-bind');
  await expect(bind).toBeVisible();
  // Nothing is skinned yet: no skinned mesh is drawn.
  expect(await page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.()))).toBe(
    false,
  );
  await bind.selectOption(armature);

  // The stack is Capture then Armature, both pointed at the armature; the offer is gone.
  const after = await nodes(page);
  const capture = Object.entries(after).find(([, n]) => n.type === 'CaptureModifier')![0];
  const deform = Object.entries(after).find(([, n]) => n.type === 'ArmatureModifier')![0];
  expect((after[capture].inputs.target as { node: string }).node).toBe(TUBE_DATA);
  expect((after[deform].inputs.target as { node: string }).node).toBe(capture);
  expect((after[TUBE].inputs.data as { node: string }).node).toBe(deform);
  for (const id of [capture, deform]) {
    expect((after[id].inputs.armature as { node: string }).node).toBe(armature);
  }
  await expect(bind).toHaveCount(0);

  // The Capture row says what it did, and names its armature.
  await page.getByTestId(`modifier-row-${capture}`).click();
  await expect(page.getByTestId('capture-status')).toHaveText('400 points bound to 3 bones.');
  await expect(page.getByTestId('skin-armature')).toHaveValue(armature);
  // Pointed at nothing, it says why nothing is captured — and pointed back, it captures again.
  await page.getByTestId('skin-armature').selectOption('');
  await expect(page.getByTestId('capture-status')).toContainText(
    'Nothing is captured: no armature is connected',
  );
  await page.getByTestId('skin-armature').selectOption(armature);
  await expect(page.getByTestId('capture-status')).toHaveText('400 points bound to 3 bones.');

  // A bone switched off in Edit mode ("deform") is left out of the capture, and comes back with it.
  const setDeform = async (on: boolean) => {
    await page.evaluate(async (id) => {
      const sel = await import('/src/app/stores/selectionStore.ts');
      const modes = await import('/src/app/stores/armatureModeStore.ts');
      const bones = await import('/src/app/stores/boneSelectionStore.ts');
      sel.useSelectionStore.getState().select(id);
      modes.useArmatureModeStore.getState().setMode(id, 'edit');
      bones.useBoneSelectionStore
        .getState()
        .selectBone(id, 'Bone_end_001', ['Bone', 'Bone_end', 'Bone_end_001']);
    }, armature);
    const box = page.getByTestId('edit-bone-deform');
    await expect(box).toBeVisible();
    await (on ? box.check() : box.uncheck());
    await page.evaluate(
      async ({ id, row }) => {
        const sel = await import('/src/app/stores/selectionStore.ts');
        const modes = await import('/src/app/stores/armatureModeStore.ts');
        modes.useArmatureModeStore.getState().setMode(id, 'object');
        sel.useSelectionStore.getState().select(row);
      },
      { id: armature, row: capture },
    );
  };
  await setDeform(false);
  await expect(page.getByTestId('capture-status')).toHaveText('400 points bound to 2 bones.');
  await setDeform(true);
  await expect(page.getByTestId('capture-status')).toHaveText('400 points bound to 3 bones.');

  // The drawn mesh is skinned now, and rests where it was stored.
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.()?.bound)),
    )
    .toBe(true);
  const restMid = await drawnAt(page, [0.25, 1.5, 0]);
  restMid.forEach((c, k) => expect(c, `rest mid ${k}`).toBeCloseTo([0.25, 1.5, 0][k], 5));

  // Pose mode: a quarter turn of the middle bone about Z, through the gizmo's own seam.
  await page.evaluate(async (id) => {
    const s = await import('/src/app/stores/selectionStore.ts');
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const g = await import('/src/app/stores/gizmoStore.ts');
    s.useSelectionStore.getState().select(id);
    modes.useArmatureModeStore.getState().setMode(id, 'pose');
    bones.useBoneSelectionStore
      .getState()
      .selectBone(id, 'Bone_end', ['Bone', 'Bone_end', 'Bone_end_001']);
    g.useGizmoStore.getState().setMode('rotate');
  }, armature);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_bone_gizmo?.()?.bone ?? null))
    .toBe('Bone_end');
  expect(
    await page.evaluate(
      (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
      [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    ),
  ).toBe(true);

  // Beside the middle bone: the worked number above.
  const mid = await drawnAt(page, [0.25, 1.5, 0]);
  expect(mid[0]).toBeCloseTo(0.25 - (0.75 * 26) / 27, 3);
  expect(mid[1]).toBeCloseTo(1.5 - (0.25 * 26) / 27, 3);
  expect(mid[2]).toBeCloseTo(0, 4);
  // The foot stays, and the top follows the turn (rigidly it would be at (−2, 1.25, 0)).
  const foot = await drawnAt(page, [0.25, 0, 0]);
  expect(Math.hypot(foot[0] - 0.25, foot[1], foot[2])).toBeLessThan(0.01);
  const top = await drawnAt(page, [0.25, 3, 0]);
  expect(Math.hypot(top[0] + 2, top[1] - 1.25, top[2])).toBeLessThan(0.08);
  // Smooth: up the outside of the bend, ring by ring (0.125 apart at rest), no two neighbours end
  // up more than 0.3 apart, and each ring has moved further than the one below it.
  const rings = await page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    const out: { y: number; at: number[] }[] = [];
    for (let i = 0; i < s.count; i++) {
      const r = s.rest(i);
      if (Math.abs(r[0] + 0.25) < 1e-4 && Math.abs(r[2]) < 1e-4)
        out.push({ y: r[1], at: s.vertex(i) });
    }
    return out.sort((a, b) => a.y - b.y);
  });
  expect(rings.map((r) => Math.round(r.y * 8))).toEqual(Array.from({ length: 25 }, (_, k) => k));
  for (let k = 1; k < rings.length; k++) {
    const [here, below] = [rings[k], rings[k - 1]];
    expect(
      Math.hypot(here.at[0] - below.at[0], here.at[1] - below.at[1]),
      `ring ${k} tore from the one below it`,
    ).toBeLessThan(0.3);
    const moved = (r: { y: number; at: number[] }) => Math.hypot(r.at[0] + 0.25, r.at[1] - r.y);
    expect(moved(here), `ring ${k} moved less than the one below it`).toBeGreaterThan(moved(below));
  }

  await frames(page);
  const shot = await page.locator('canvas').first().screenshot();
  await testInfo.attach('bent-tube', { body: shot, contentType: 'image/png' });
});

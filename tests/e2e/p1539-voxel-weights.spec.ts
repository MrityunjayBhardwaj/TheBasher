// #1539 — the Capture node's voxel method, in the app: a tube and a three-bone chain made here are
// bound, the method is switched to "voxel" from the Capture's own card, and turning the middle bone
// bends the tube smoothly. The tube has no caps — the case the reference implementation leaves with
// no weights at all — and the Capture says every point was reached.
//
// Then the cost of the method where it will run: 72 bones on a 24,746-point character at 128, timed
// and its memory counted in this browser.
//
// The tube stands on +Y from 0 to 3 at radius 0.25; the chain's joints are at y = 0, 1 and 2. At
// the default falloff (0.2) weight goes near the inverse square of distance, so the point beside
// the middle of the middle bone, (0.25, 1.5, 0), is 1 : 0.2 : 0.2 on the middle bone and its two
// neighbours. A quarter turn of the middle bone about Z carries the middle and top bones' share,
// 1.2/1.4, of the way to (−0.5, 1.25, 0): (−0.393, 1.286, 0).

import { existsSync } from 'node:fs';
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
      dispatch: (op: unknown, who: string, label: string) => void;
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

const TUBE = 'p1539_tube';
const TUBE_DATA = 'p1539_tube_data';

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

async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await settleViewFit(page);
}

test('#1539 — an open tube bound by voxel distance bends smoothly, and says every point was reached', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.evaluate(() =>
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0),
  );

  // The tube: a stored mesh with no caps, no weights and no groups, standing at the origin.
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
  const stored = (await nodes(page))[TUBE_DATA].params.mesh as { pointLayers: unknown[] };
  expect(stored.pointLayers).toEqual([]);

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
  await page.getByTestId('armature-mode').selectOption('object');

  // Bind from the tube's modifier section: the proximity bind, as before.
  await page.evaluate(async (id) => {
    const s = await import('/src/app/stores/selectionStore.ts');
    s.useSelectionStore.getState().select(id);
  }, TUBE);
  await page.getByTestId('inspector-section-toggle-modifier').click();
  await page.getByTestId('skin-bind').selectOption(armature);
  const capture = Object.entries(await nodes(page)).find(
    ([, n]) => n.type === 'CaptureModifier',
  )![0];
  expect((await nodes(page))[capture].params.method).toBe('proximity');
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.()?.bound)),
    )
    .toBe(true);

  // What the proximity weights do to the point beside the middle bone, to tell the two apart by.
  const turn = async () => {
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
      .poll(() =>
        page.evaluate(() => (window as unknown as W).__basher_bone_gizmo?.()?.bone ?? null),
      )
      .toBe('Bone_end');
    expect(
      await page.evaluate(
        (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
        [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      ),
    ).toBe(true);
  };
  await turn();
  const byProximity = await drawnAt(page, [0.25, 1.5, 0]);
  expect(byProximity[0]).toBeCloseTo(0.25 - (0.75 * 26) / 27, 3);

  // Switch the method on the Capture's own card. The pose stays; the weights under it change.
  await page.evaluate(
    async ({ id, row }) => {
      const sel = await import('/src/app/stores/selectionStore.ts');
      const modes = await import('/src/app/stores/armatureModeStore.ts');
      modes.useArmatureModeStore.getState().setMode(id, 'object');
      sel.useSelectionStore.getState().select(row);
    },
    { id: armature, row: capture },
  );
  const method = page.getByTestId(`inspector-enum-${capture}-method`);
  await expect(method).toHaveValue('proximity');
  await method.selectOption('voxel');
  expect((await nodes(page))[capture].params).toMatchObject({
    method: 'voxel',
    resolution: 128,
    falloff: 0.2,
  });
  // An open tube, and every point reached: the sentence has nothing to add, and is not a warning.
  const status = page.getByTestId('capture-status');
  await expect(status).toHaveText('400 points bound to 3 bones.');
  await expect(status).toHaveAttribute('data-captured', 'true');

  // The same turn, by voxel weights: the worked number at the top, to the grid's accuracy.
  const mid = await drawnAt(page, [0.25, 1.5, 0]);
  expect(mid[0]).toBeGreaterThan(-0.43);
  expect(mid[0]).toBeLessThan(-0.36);
  expect(mid[1]).toBeGreaterThan(1.27);
  expect(mid[1]).toBeLessThan(1.3);
  expect(Math.abs(mid[2])).toBeLessThan(0.01);
  // Not the proximity answer: the drawn mesh took the new weights.
  expect(Math.abs(mid[0] - byProximity[0])).toBeGreaterThan(0.04);
  // The top follows the turn (rigidly it would be at (−2, 1.25, 0)).
  const top = await drawnAt(page, [0.25, 3, 0]);
  expect(Math.hypot(top[0] + 2, top[1] - 1.25, top[2])).toBeLessThan(0.25);
  // Smooth: up the outside of the bend, ring by ring (0.125 apart at rest), no two neighbours end
  // up more than 0.3 apart. And the share of each ring the turned bones hold — how far it went of
  // the way a rigid turn would take it, from (−0.25, y) to (1 − y, 0.75) — rises from the foot to
  // the top without stepping back (to the grid's accuracy, 0.02).
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
  const share = (r: { y: number; at: number[] }) =>
    Math.hypot(r.at[0] + 0.25, r.at[1] - r.y) / Math.hypot(1.25 - r.y, 0.75 - r.y);
  for (let k = 1; k < rings.length; k++) {
    const [here, below] = [rings[k], rings[k - 1]];
    expect(
      Math.hypot(here.at[0] - below.at[0], here.at[1] - below.at[1]),
      `ring ${k} tore from the one below it`,
    ).toBeLessThan(0.3);
    expect(share(here), `ring ${k} is held less than the one below it`).toBeGreaterThan(
      share(below) - 0.02,
    );
  }
  expect(share(rings[0])).toBeLessThan(0.1);
  expect(share(rings[12])).toBeGreaterThan(0.75);
  expect(share(rings[24])).toBeGreaterThan(0.9);
  await frames(page);
  await testInfo.attach('bent-tube-voxel', {
    body: await page.locator('canvas').first().screenshot(),
    contentType: 'image/png',
  });

  // A rigid falloff, from the same card: the foot, which the turned bones still held a little of,
  // stops moving.
  const footSmooth = await drawnAt(page, [0.25, 0, 0]);
  expect(Math.hypot(footSmooth[0] - 0.25, footSmooth[1])).toBeGreaterThan(0.05);
  const falloff = page.getByTestId(`inspector-input-${capture}-falloff`);
  await falloff.fill('1');
  await falloff.press('Enter');
  expect((await nodes(page))[capture].params.falloff).toBe(1);
  const footRigid = await drawnAt(page, [0.25, 0, 0]);
  expect(Math.hypot(footRigid[0] - 0.25, footRigid[1])).toBeLessThan(0.02);

  // The armature moved out of the tube: no bone is in the volume. Every point is still bound (by
  // straight-line distance), and the card says so by name instead of leaving the mesh at rest.
  await page.evaluate((id) => {
    (window as unknown as W).__basher_dag
      .getState()
      .dispatch(
        { type: 'setParam', nodeId: id, paramPath: 'position', value: [1, 0, 0] },
        'user',
        'move armature',
      );
  }, armature);
  await expect(status).toHaveText(
    "400 points bound to 3 bones. 400 could not be reached through the mesh's inside and are bound by straight-line distance instead. 3 bones lie outside the mesh's volume, so nothing is measured from them: Bone, Bone_end, Bone_end_001.",
  );
  await expect(status).toHaveAttribute('data-captured', 'false');
  await testInfo.attach('capture-card-outside', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('#1539 — 72 bones at 128 in the browser: the time it takes and the memory it holds', async ({
  page,
}, testInfo) => {
  // The character is a vendor file that cannot be redistributed, so it is not in the repository:
  // this row runs where the file is present and is skipped, by name, where it is not (CI).
  test.skip(!existsSync('public/assets/mixamo-xbot.glb'), 'the vendor character is not present');
  test.setTimeout(180_000);
  await boot(page);
  const measured = await page.evaluate(async () => {
    const { xbotArmsDown } = await import('/src/test-utils/xbotArmsDown.ts');
    const { captureByVoxel } = await import('/src/nodes/captureVoxel.ts');
    const bytes = await (await fetch('/assets/mixamo-xbot.glb')).arrayBuffer();
    const xbot = await xbotArmsDown(bytes, 0);
    const bones = [
      ...xbot.bones,
      ...[0, 1, 2, 3, 4].map((i) => ({
        name: `extra.${i}`,
        head: [0, 1 + i * 0.05, 0] as [number, number, number],
        tail: [0, 1.05 + i * 0.05, 0] as [number, number, number],
      })),
    ];
    const opts = { maxInfluences: 4, falloff: 0.2, resolution: 128 };
    // Every byte of typed array made during a capture: nothing inside is freed before it returns.
    const kinds = [
      'Float32Array',
      'Float64Array',
      'Int32Array',
      'Uint32Array',
      'Int16Array',
      'Uint16Array',
      'Int8Array',
      'Uint8Array',
    ];
    const scope = globalThis as unknown as Record<string, unknown>;
    const counted = (count: number) => {
      const kept = kinds.map((k) => scope[k]);
      let made = 0;
      kinds.forEach((k, i) => {
        scope[k] = new Proxy(kept[i] as object, {
          construct(target, args) {
            const array = Reflect.construct(target as never, args) as { byteLength: number };
            if (!(args[0] instanceof ArrayBuffer)) made += array.byteLength;
            return array;
          },
        });
      });
      try {
        const got = captureByVoxel(xbot.mesh, bones.slice(0, count), opts)!;
        return { made, dims: got.dims, filled: got.filled, unreached: got.unreached };
      } finally {
        kinds.forEach((k, i) => (scope[k] = kept[i]));
      }
    };
    const many = counted(72);
    const few = counted(4);
    // Timed apart from the counting, three times, on warm code.
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      captureByVoxel(xbot.mesh, bones, opts);
      times.push(performance.now() - t);
    }
    return { many, few, times, points: xbot.mesh.points.length / 3, bones: bones.length };
  });
  await testInfo.attach('measured', {
    body: JSON.stringify(measured, null, 2),
    contentType: 'application/json',
  });
  console.log('#1539 measured in the browser:', JSON.stringify(measured));
  expect(measured.bones).toBe(72);
  expect(measured.points).toBe(24746);
  expect(measured.many.unreached).toBe(0);
  // One field, written over bone after bone: 72 bones hold what 4 do.
  expect(measured.many.made).toBe(measured.few.made);
  const cubes = measured.many.dims[0] * measured.many.dims[1] * measured.many.dims[2];
  expect(cubes).toBeLessThanOrEqual(133 ** 3);
  // The stated bound: 24 bytes a grid cube and 153 a point.
  expect(measured.many.made).toBeLessThanOrEqual(24 * cubes + 153 * measured.points + 4096);
  expect(measured.many.made).toBeLessThan(16 * 1024 * 1024);
  // It runs where the node evaluates, on the main thread, so it must stay a pause and not a hang.
  // Measured at 0.3–0.5 s on a developer machine; software-rendered CI runners are several times
  // slower, and the budget allows for that.
  expect(Math.min(...measured.times)).toBeLessThan(5000);
});

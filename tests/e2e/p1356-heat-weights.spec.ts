// #1356 — the Capture node's heat method, in the app: two fingers side by side, joined at the
// knuckles, each with its own bone. Bound by straight-line distance, bending one finger drags the
// facing side of the other with it; with the method switched to "heat" on the Capture's own card
// the other finger stays where it is.
//
// The fingers are one tube bent back on itself like a hairpin (`hairpinMesh`): legs of radius 0.1
// standing at x = −0.101 and x = +0.101, so their facing sides are two thousandths apart. Bone
// `Up` runs up the first leg and bone `Down` down the second. The point watched is half way up
// the first leg on the side facing the second: it rests at (−0.001, 0.504, 0), 0.1 from its own
// bone and 0.102 from the other.
//
// Then the cost of the method where it will run: a 24,746-point character with 67 bones, timed and
// its memory counted in this browser.

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

const HAND = 'p1356_hand';
const HAND_DATA = 'p1356_hand_data';
const SHAPE = { radius: 0.1, half: 0.101, leg: 1, radial: 16, rings: 47 };
const BONES = ['Up', 'Up_end', 'Down', 'Down_end'];

const nodes = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_dag.getState().state.nodes);

const frames = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );

/** Where the drawn vertex that RESTS nearest `at` is now, and where exactly it rests. */
async function drawnAt(
  page: Page,
  at: [number, number, number],
): Promise<{ rest: number[]; now: number[] }> {
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
    if (bestD > 0.01) throw new Error(`no vertex rests at ${target.join(', ')} (nearest ${bestD})`);
    return { rest: s.rest(best), now: s.vertex(best) };
  }, at);
}
const moved = (v: { rest: number[]; now: number[] }) =>
  Math.hypot(v.now[0] - v.rest[0], v.now[1] - v.rest[1], v.now[2] - v.rest[2]);

async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  await settleViewFit(page);
}

test('#1356 — two fingers a hair apart: bound by heat, bending one leaves the other where it is', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await boot(page);

  // An armature the way the app makes one (Add › Armature: a skeleton, its base pose layer and the
  // Object standing it), then its bones set to the two fingers'. `Up` and `Down` each have an end
  // bone that moves no skin, so each is drawn the length of its finger.
  await page.mouse.move(700, 450);
  await page.keyboard.press('Shift+A');
  await page.getByText('Empty', { exact: true }).hover();
  await page.getByText('Armature', { exact: true }).click();
  await expect(page.getByTestId('armature-mode')).toBeVisible();
  const armature = await page.evaluate(async () => {
    const s = await import('/src/app/stores/selectionStore.ts');
    return s.useSelectionStore.getState().primaryNodeId!;
  });

  // The two fingers: a stored mesh with no weights. And the starter scene's box out of the way.
  await page.evaluate(
    async ({ hand, data, shape }) => {
      const w = window as unknown as W;
      const { hairpinMesh } = await import('/src/test-utils/hairpinMesh.ts');
      const { packMeshData } = await import('/src/app/meshGeometryData.ts');
      const dag = w.__basher_dag.getState();
      const scene = dag.state.outputs.scene!.node;
      const skeleton = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'Skeleton')![0];
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: data,
            nodeType: 'PolyMeshData',
            params: { mesh: packMeshData(hairpinMesh(shape)), material: null },
          },
          { type: 'addNode', nodeId: hand, nodeType: 'Object', params: {} },
          {
            type: 'connect',
            from: { node: data, socket: 'out' },
            to: { node: hand, socket: 'data' },
          },
          {
            type: 'connect',
            from: { node: hand, socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
          {
            type: 'setParam',
            nodeId: skeleton,
            paramPath: 'bones',
            value: [
              { name: 'Up', parent: -1, position: [-shape.half, 0, 0], rotation: [0, 0, 0] },
              {
                name: 'Up_end',
                parent: 0,
                position: [0, shape.leg, 0],
                rotation: [0, 0, 0],
                deform: false,
              },
              {
                name: 'Down',
                parent: -1,
                position: [shape.half, shape.leg, 0],
                rotation: [0, 0, 0],
              },
              {
                name: 'Down_end',
                parent: 2,
                position: [0, -shape.leg, 0],
                rotation: [0, 0, 0],
                deform: false,
              },
            ],
          },
          {
            type: 'disconnect',
            from: { node: 'n_box', socket: 'out' },
            to: { node: scene, socket: 'children' },
          },
        ],
        'user',
        'add two fingers',
      );
      const t = w.__basher_three.getState();
      t.controlsTarget!.set(0, 0.6, 0);
      t.camera.position.set(0, 0.6, 2.6);
    },
    { hand: HAND, data: HAND_DATA, shape: SHAPE },
  );
  const stored = (await nodes(page))[HAND_DATA].params.mesh as { pointLayers: unknown[] };
  expect(stored.pointLayers).toEqual([]);

  // Bind from the mesh's modifier section: the proximity bind.
  await page.evaluate(async (id) => {
    const s = await import('/src/app/stores/selectionStore.ts');
    s.useSelectionStore.getState().select(id);
  }, HAND);
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

  // Bend the second finger: `Down` a sixth of a turn about Z, about its own head at the knuckle.
  await page.evaluate(
    async ({ id, names }) => {
      const s = await import('/src/app/stores/selectionStore.ts');
      const modes = await import('/src/app/stores/armatureModeStore.ts');
      const bones = await import('/src/app/stores/boneSelectionStore.ts');
      const g = await import('/src/app/stores/gizmoStore.ts');
      s.useSelectionStore.getState().select(id);
      modes.useArmatureModeStore.getState().setMode(id, 'pose');
      bones.useBoneSelectionStore.getState().selectBone(id, 'Down', names);
      g.useGizmoStore.getState().setMode('rotate');
    },
    { id: armature, names: BONES },
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_bone_gizmo?.()?.bone ?? null))
    .toBe('Down');
  expect(
    await page.evaluate(
      (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
      [0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
    ),
  ).toBe(true);

  // The point half way up the FIRST finger, on the side facing the second; and its twin across
  // the gap on the second finger, which is the one being bent.
  const WATCHED: [number, number, number] = [-0.001, 0.504, 0];
  const TWIN: [number, number, number] = [0.001, 0.504, 0];
  const byProximity = await drawnAt(page, WATCHED);
  expect(byProximity.rest[0]).toBeCloseTo(-0.001, 4);
  expect(byProximity.rest[1]).toBeCloseTo(0.504, 2);
  // By straight-line distance it is nearly half the other finger's: it goes nearly half the way
  // the bent finger's own point goes.
  const twinNear = await drawnAt(page, TWIN);
  expect(moved(twinNear)).toBeGreaterThan(0.2);
  expect(moved(byProximity)).toBeGreaterThan(0.4 * moved(twinNear));
  await testInfo.attach('fingers-proximity', {
    body: await page.locator('canvas').first().screenshot(),
    contentType: 'image/png',
  });

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
  await method.selectOption('heat');
  expect((await nodes(page))[capture].params).toMatchObject({ method: 'heat', maxInfluences: 4 });
  const status = page.getByTestId('capture-status');
  await expect(status).toHaveText('752 points bound to 2 bones.');
  await expect(status).toHaveAttribute('data-captured', 'true');

  // The first finger's facing side stays where it rests; the bent finger's own point goes all the
  // way with its bone (a sixth of a turn about (0.101, 1, 0)).
  const byHeat = await drawnAt(page, WATCHED);
  expect(moved(byHeat)).toBeLessThan(0.005);
  const twinHeat = await drawnAt(page, TWIN);
  const [dx, dy] = [twinHeat.rest[0] - 0.101, twinHeat.rest[1] - 1];
  const [c, s] = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)];
  expect(twinHeat.now[0]).toBeCloseTo(0.101 + dx * c - dy * s, 2);
  expect(twinHeat.now[1]).toBeCloseTo(1 + dx * s + dy * c, 2);
  // Over the top, where the two really do join, the skin goes part of the way: a blend, not a tear.
  const top = await drawnAt(page, [0, 1.201, 0]);
  expect(moved(top)).toBeGreaterThan(0.01);
  expect(moved(top)).toBeLessThan(0.2);
  await frames(page);
  await testInfo.attach('fingers-heat', {
    body: await page.locator('canvas').first().screenshot(),
    contentType: 'image/png',
  });

  // The armature moved a unit aside: from the wall facing it the bones are in front, and from the
  // far wall the near one is in the way. The card says the mesh was bound by nearness instead, and
  // that the farther bone, nearest to nothing now, holds nothing.
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
    '752 points bound to 2 bones. 752 are on parts with no bone in sight from inside, and are bound by nearness instead. 1 bone holds no point: Down.',
  );
  await expect(status).toHaveAttribute('data-captured', 'false');
  await testInfo.attach('capture-card-no-bone-in-sight', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('#1356 — a 67-bone character by heat in the browser: the time it takes and the memory it holds', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await boot(page);
  const measured = await page.evaluate(async () => {
    const { xbotArmsDown } = await import('/src/test-utils/xbotArmsDown.ts');
    const { bytesMadeBy } = await import('/src/test-utils/bytesMadeBy.ts');
    const { captureByHeat } = await import('/src/nodes/captureHeat.ts');
    const bytes = await (await fetch('/assets/mixamo-xbot.glb')).arrayBuffer();
    const xbot = await xbotArmsDown(bytes, 75);
    const opts = { maxInfluences: 4 };
    let got = captureByHeat(xbot.mesh, xbot.bones, opts)!;
    const made = bytesMadeBy(() => {
      got = captureByHeat(xbot.mesh, xbot.bones, opts)!;
    });
    // Timed apart from the counting, three times, on warm code.
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      captureByHeat(xbot.mesh, xbot.bones, opts);
      times.push(performance.now() - t);
    }
    return {
      made,
      times,
      points: xbot.mesh.points.length / 3,
      triangles: xbot.mesh.faceSizes.reduce((sum, n) => sum + n - 2, 0),
      bones: xbot.bones.length,
      pieces: got.pieces,
      heated: got.heated,
      unreached: got.unreached,
      unbound: got.unbound,
      unsettled: got.unsettled,
      steps: got.steps,
      outside: got.outside.length,
    };
  });
  await testInfo.attach('measured', {
    body: JSON.stringify(measured, null, 2),
    contentType: 'application/json',
  });
  console.log('#1356 measured in the browser:', JSON.stringify(measured));
  expect(measured).toMatchObject({
    bones: 67,
    points: 24746,
    triangles: 49112,
    pieces: 95,
    unreached: 958,
    unbound: 0,
    unsettled: 0,
    outside: 6,
  });
  // The stated bound: under 300 bytes a point and 200 a triangle.
  expect(measured.made).toBeLessThan(300 * measured.points + 200 * measured.triangles);
  // It runs where the node evaluates, on the main thread, so it must stay a pause and not a hang.
  // Measured at about 0.15 s on a developer machine; software-rendered CI runners are several
  // times slower, and the budget allows for that.
  expect(Math.min(...measured.times)).toBeLessThan(5000);
});

// #537 — an animated param that feeds a GEOMETRY HANDLE must reach the screen.
//
// ── THE BUG THIS PINS ───────────────────────────────────────────────────────────────
//
// The render-time overlay writes an animated param at its param path, rebased for the band:
// `channelPathForBand('children','size')` → `value.data.size`. But `MeshDataValue` has no
// `size` — it carries a `GeometryRef`, and `ObjectR` draws through
// `getForAttach(data.geometry)`. So the write landed on a field with no reader. Nothing
// errored, nothing was null, the inspector reported the interpolated value, and the box
// never resized. The animation was real everywhere except on screen.
//
// The repair is a REBUILD rather than the clear the material half uses (#536 S2b): a
// cleared geometry ref draws nothing at all, so the seam folds the written params back into
// the descriptor and re-mints through the same builder the evaluator used.
//
// ── WHY THESE THREE SUBJECTS ────────────────────────────────────────────────────────
//
// Measured on the broken build, in one run: a box's `size` FROZEN, a sphere's `radius`
// FROZEN, and an ArrayModifier's own `count` FROZEN. The issue named only the first and
// guessed at the second; the third is a MODIFIER's param, which reaches a recursive
// descriptor by the same road and was not predicted at all. One subject would have pinned a
// `size` fix; three pin the rule, which is that no param feeding a descriptor may freeze.
//
// The positive control is an animated `position` on the same road. Without it a build where
// the playhead simply never moved would pass every assertion here by freezing everything —
// a uniform result indicts the instrument, not the product.
//
// Bounds are read as a real world-space extent rather than as a geometry uuid: a uuid says
// the instance changed, an extent says the object is drawing the size the director asked for.
//
// REF: src/app/overlayWithIdentity.ts (`repairInvalidatedIdentity` — the seam);
//      src/app/modifierGeometry.ts (`rebuildGeometryRef`); src/app/objectDataBand.ts
//      (`handleFieldsForBand`); issues #536, #537.

import { expect, test } from './_fixtures';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface UiWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_mesh_world_bounds?: (id: string) => [number, number, number] | null;
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
}

test('#537 an animated size, radius and modifier count all reach the screen', async ({ page }) => {
  await page.goto('/');
  const layout = page.getByTestId('layout');
  const starter = page.getByRole('button', { name: /Open example Starter Scene/i });
  await Promise.race([
    layout.waitFor({ timeout: 15_000 }).catch(() => undefined),
    starter.waitFor({ timeout: 15_000 }).catch(() => undefined),
  ]);
  if (await starter.isVisible().catch(() => false)) await starter.click();
  await expect(layout).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as UiWindow;
    return Boolean(w.__basher_dag && w.__basher_dag.getState().state.outputs.scene);
  });

  await page.evaluate(() => {
    const w = window as unknown as UiWindow;
    const dag = w.__basher_dag.getState();
    const scene = dag.state.outputs.scene!.node;
    const mat = { name: 'p537', base: { color: '#c81e5a' } };
    const ops: Op[] = [];
    const wire = (data: string, obj: string) =>
      ops.push(
        { type: 'addNode', nodeId: obj, nodeType: 'Object', params: { position: [0, 0, 0] } },
        { type: 'connect', from: { node: data, socket: 'out' }, to: { node: obj, socket: 'data' } },
        {
          type: 'connect',
          from: { node: obj, socket: 'out' },
          to: { node: scene, socket: 'children' },
        },
      );
    const anim = (id: string, target: string, path: string, a: unknown, b: unknown, type: string) =>
      ops.push({
        type: 'addNode',
        nodeId: id,
        nodeType: type,
        params: {
          name: id,
          target,
          paramPath: path,
          keyframes: [
            { time: 0, value: a, easing: 'linear' },
            { time: 2, value: b, easing: 'linear' },
          ],
        },
      });

    // A — a box's `size`, the param the issue was filed for.
    ops.push({
      type: 'addNode',
      nodeId: 'k537_box',
      nodeType: 'BoxData',
      params: { size: [1, 1, 1], material: mat },
    });
    wire('k537_box', 'k537_box_o');
    anim('k537_ch_size', 'k537_box', 'size', [1, 1, 1], [4, 4, 4], 'KeyframeChannelVec3');

    // B — a sphere's `radius`: the multi-param descriptor, where a rebuild that dropped the
    // untouched fields would reset the segment counts instead of only the radius.
    ops.push({
      type: 'addNode',
      nodeId: 'k537_sph',
      nodeType: 'SphereData',
      params: { radius: 1, widthSegments: 16, heightSegments: 12, material: mat },
    });
    wire('k537_sph', 'k537_sph_o');
    anim('k537_ch_rad', 'k537_sph', 'radius', 1, 3, 'KeyframeChannelNumber');

    // C — an ArrayModifier's own `count`, on the data lane (#415): source → modifier → Object.
    // A RECURSIVE descriptor, whose nested source handle must survive the rebuild untouched.
    ops.push(
      {
        type: 'addNode',
        nodeId: 'k537_src',
        nodeType: 'BoxData',
        params: { size: [1, 1, 1], material: mat },
      },
      {
        type: 'addNode',
        nodeId: 'k537_arr',
        nodeType: 'ArrayModifier',
        params: { count: 2, offset: [2, 0, 0], muted: false },
      },
      {
        type: 'connect',
        from: { node: 'k537_src', socket: 'out' },
        to: { node: 'k537_arr', socket: 'target' },
      },
    );
    wire('k537_arr', 'k537_arr_o');
    anim('k537_ch_cnt', 'k537_arr', 'count', 2, 5, 'KeyframeChannelNumber');

    // D — the positive control: an animated position, which travels the transform road and
    // was never affected by this defect.
    ops.push({
      type: 'addNode',
      nodeId: 'k537_ctl',
      nodeType: 'BoxData',
      params: { size: [1, 1, 1], material: mat },
    });
    wire('k537_ctl', 'k537_ctl_o');
    anim('k537_ch_pos', 'k537_ctl_o', 'position', [0, 0, 0], [5, 0, 0], 'KeyframeChannelVec3');

    dag.dispatchAtomic(ops, 'e2e', '#537 animated geometry params');
  });
  await page.waitForTimeout(800);

  const sample = async () =>
    page.evaluate(() => {
      const w = window as unknown as UiWindow;
      const read = (id: string) => ({
        bounds: w.__basher_mesh_world_bounds ? w.__basher_mesh_world_bounds(id) : null,
        pos: w.__basher_mesh_world_position ? w.__basher_mesh_world_position(id) : null,
      });
      return {
        box: read('k537_box_o'),
        sphere: read('k537_sph_o'),
        array: read('k537_arr_o'),
        control: read('k537_ctl_o'),
      };
    });
  const setTime = async (s: number) => {
    await page.evaluate((secs) => {
      const w = window as unknown as UiWindow;
      w.__basher_time?.getState().setTime(secs);
    }, s);
    await page.waitForTimeout(500);
  };

  await setTime(0);
  const t0 = await sample();
  await setTime(2);
  const t2 = await sample();

  // The premise: every subject drew at t=0. Without this the assertions below would also be
  // satisfied by a scene where nothing rendered at all.
  for (const [name, r] of Object.entries(t0)) {
    expect(r.bounds, `${name} must be drawn at t=0`).not.toBeNull();
  }

  // The control, FIRST — if the playhead did not move, nothing below means anything.
  expect(t0.control.pos?.[0]).toBeCloseTo(0, 3);
  expect(t2.control.pos?.[0]).toBeCloseTo(5, 3);

  // A — size 1 → 4 is the extent itself.
  expect(t0.box.bounds?.[0]).toBeCloseTo(1, 3);
  expect(t2.box.bounds?.[0]).toBeCloseTo(4, 3);

  // B — radius 1 → 3, and the extent is the DIAMETER. Asserting the value rather than
  // "it grew" is what catches a rebuild that also reset the segment counts: a coarser
  // sphere still grows, and its extent would land short of 6.
  expect(t0.sphere.bounds?.[0]).toBeCloseTo(2, 1);
  expect(t2.sphere.bounds?.[0]).toBeCloseTo(6, 1);

  // C — count 2 → 5 at offset 2 along x: the merged extent is 2*(n-1) + 1, so 3 → 9. The
  // arithmetic is the point: a rebuild that dropped `offset` while folding in `count` would
  // still grow, and would land on 5 rather than 9.
  expect(t0.array.bounds?.[0]).toBeCloseTo(3, 2);
  expect(t2.array.bounds?.[0]).toBeCloseTo(9, 2);

  // And the control's own geometry never moved — the transform road must not have started
  // rebuilding handles as a side effect.
  expect(t2.control.bounds?.[0]).toBeCloseTo(1, 3);
});

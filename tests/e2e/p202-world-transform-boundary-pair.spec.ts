// #202 (epic #201) — the H40 boundary-pair for the pure WORLD transform: the
// resolver (side B, __basher_world_transform) == the REAL rendered three.js
// object's world position (side A, __basher_mesh_world_position) for a NESTED
// Transform → Box hierarchy, at ≥2 playhead times.
//
// This is the de-risk milestone of slice #202. The hard risk is that the pure
// resolveWorldTransform DRIFTS from the actual rendered world matrix three.js
// composes from the nested <group>/<mesh> tree. The only way to falsify it is to
// observe BOTH sides against the REAL object — not the resolver alone. Revert the
// pure lift (e.g. drop a parent's matrix from the walk) → side B diverges from
// side A and these fail.
//
// Side A: __basher_mesh_world_position(xfId) — the wrapping group is named with
//   the top-level producer id (the Transform), and the seam descends to the first
//   Mesh under it (the nested box), reporting its WORLD position.
// Side B: __basher_world_transform(boxId) — the pure resolver for the box node,
//   which accumulates Transform.local · box.local off-graph.

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: {
    getState: () => { pause: () => void; setTime: (s: number) => void };
  };
  __basher_world_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: number[]; scale: number[] } | null;
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
}

const XF_ID = 'n_p202_xf';
const BOX_LOCAL_X = 1;

/** Re-parent the default box under a NEW Transform wired into the scene, and
 *  animate the Transform's position 0→10 on X over t∈[0,2]. Returns nothing —
 *  ids are the module constants. */
async function buildNestedAnimatedTransform(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time);
  });
  await page.evaluate(
    ({ xfId, boxLocalX }) => {
      const w = window as unknown as BasherWindow;
      const dispatch = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
      // Give the box a non-zero local X so world = parent + local is observable
      // (not trivially equal to the parent's position).
      dispatch({
        type: 'setParam',
        nodeId: 'n_box',
        paramPath: 'position',
        value: [boxLocalX, 0, 0],
      });
      // Insert Transform between n_box and the scene.
      dispatch({
        type: 'addNode',
        nodeId: xfId,
        nodeType: 'Transform',
        params: { name: 'p202xf', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
      dispatch({
        type: 'disconnect',
        from: { node: 'n_box', socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
      dispatch({
        type: 'connect',
        from: { node: 'n_box', socket: 'out' },
        to: { node: xfId, socket: 'target' },
      });
      dispatch({
        type: 'connect',
        from: { node: xfId, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      });
      // Animate the Transform's position via a free-floating direct channel (V57).
      dispatch({
        type: 'addNode',
        nodeId: 'n_p202_ch',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'p202pos',
          target: xfId,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: [0, 0, 0], easing: 'linear' },
            { time: 2, value: [10, 0, 0], easing: 'linear' },
          ],
        },
      });
    },
    { xfId: XF_ID, boxLocalX: BOX_LOCAL_X },
  );
}

test.describe('#202 world-transform boundary-pair (H40)', () => {
  test('pure resolveWorldTransform == rendered world position, nested + animated, ≥2 times', async ({
    page,
  }) => {
    await page.goto('/');
    await buildNestedAnimatedTransform(page);

    // Sample at two distinct playhead times; the parent moves so the child's
    // world X moves: t=0 → 0+1=1, t=2 → 10+1=11.
    const samples = [
      { seconds: 0, expectX: BOX_LOCAL_X },
      { seconds: 2, expectX: 10 + BOX_LOCAL_X },
    ];

    for (const s of samples) {
      await page.evaluate((seconds) => {
        const w = window as unknown as BasherWindow;
        w.__basher_time!.getState().pause();
        w.__basher_time!.getState().setTime(seconds);
      }, s.seconds);

      // Wait for the render (DirectChannelsR useFrame) to move the real object.
      await page.waitForFunction(
        ({ xfId, expectX }) => {
          const w = window as unknown as BasherWindow;
          const p = w.__basher_mesh_world_position?.(xfId);
          return p != null && Math.abs(p[0] - expectX) < 1e-2;
        },
        { xfId: XF_ID, expectX: s.expectX },
      );

      const { sideA, sideB } = await page.evaluate(
        ({ xfId, seconds }) => {
          const w = window as unknown as BasherWindow;
          const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
          return {
            sideA: w.__basher_mesh_world_position!(xfId), // rendered (descends to box mesh)
            sideB: w.__basher_world_transform!('n_box', ctx)?.position ?? null, // pure resolver
          };
        },
        { xfId: XF_ID, seconds: s.seconds },
      );
      console.log(
        `[p202 t=${s.seconds}] sideA=${JSON.stringify(sideA)} sideB=${JSON.stringify(sideB)}`,
      );

      // The H40 boundary-pair: pure world == rendered world, all three axes.
      expect(sideA).not.toBeNull();
      expect(sideB).not.toBeNull();
      expect(sideB![0]).toBeCloseTo(sideA![0], 3);
      expect(sideB![1]).toBeCloseTo(sideA![1], 3);
      expect(sideB![2]).toBeCloseTo(sideA![2], 3);
      // And it matches the hand-computed expectation (the resolver isn't echoing).
      expect(sideB![0]).toBeCloseTo(s.expectX, 3);
    }
  });
});

// #266/#267 ([[V88]] N6/N2, [[V45]] #1) — nested overlays render. A BoxMesh nested
// under a Y-90°-rotated Transform obeys BOTH a Track-To (constraint) AND a direct
// position channel — previously a total no-op (overlays mounted only at the
// top-level scene-child loop; a nested node rendered through the id-less MeshChild).
//
// Render == INTENDED (the nested mesh has no named group, so it's addressed via the
// top-level Transform's id, which finds the nested mesh). Two proofs:
//  (1) B1-B3+A2: a Track-To on the nested box → rendered -Z aims at the target,
//      CORRECTLY under the rotated parent (A2 = parentWorld⁻¹·aimWorld; without it
//      the aim is off by the parent's 90°). Falsify: mute → reverts to authored.
//  (2) B1-B3: a nested position channel → the nested box's world position animates.
//      Falsify: at t=0 vs t=2 the world position differs.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';

interface W {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_mesh_world_quaternion?: (id: string) => [number, number, number, number] | null;
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}

function minusZ(q: number[]): [number, number, number] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * -1 - z * 0);
  const ty = 2 * (z * 0 - x * -1);
  const tz = 2 * (x * 0 - y * 0);
  return [w * tx + (y * tz - z * ty), w * ty + (z * tx - x * tz), -1 + w * tz + (x * ty - y * tx)];
}
function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const TF = 'n266_tf'; // rotated parent Transform (top-level; names the render group)
const BOX = 'n266_box'; // the nested box

test.describe('#266/#267 nested overlays (constraint + channel) under a rotated parent', () => {
  test('nested Track-To aims at the target under a rotated parent (B1-B3 + A2)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_quaternion);
    });
    await page.evaluate(
      ({ tf, box, boxOps }) => {
        const w = window as unknown as W;
        const d = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
        w.__basher_time!.getState().pause();
        w.__basher_time!.getState().setTime(0);
        // #365 Slice 2: the nested box is a split cube (Object → BoxData); the Object
        // keeps `box`, so the Transform.target wiring, the Track-To (target: box) and
        // the world reads are unchanged — a nested Object is posable + constrainable.
        for (const op of boxOps) d(op);
        d({
          type: 'addNode',
          nodeId: tf,
          nodeType: 'Transform',
          params: { position: [2, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
        });
        d({
          type: 'connect',
          from: { node: box, socket: 'out' },
          to: { node: tf, socket: 'target' },
        });
        d({
          type: 'connect',
          from: { node: tf, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        });
        // Box world pos = [2,0,0]; aim at [2,0,10] → intended -Z = [0,0,1].
        d({
          type: 'addNode',
          nodeId: 'n266_tt',
          nodeType: 'TrackTo',
          params: {
            name: 'tt',
            target: box,
            aimNode: '',
            aimPoint: [2, 0, 10],
            up: [0, 1, 0],
            mute: false,
          },
        });
      },
      { tf: TF, box: BOX, boxOps: splitCubeOps({ objectId: BOX, position: [0, 0, 0] }) },
    );
    await page.waitForTimeout(400);

    const q = await page.evaluate(
      (tf) => (window as unknown as W).__basher_mesh_world_quaternion!(tf),
      TF,
    );
    expect(q, 'nested constrained mesh rendered').not.toBeNull();
    const dir = norm(minusZ(q!));
    // Rendered -Z aims at the target (world), CORRECTLY re-expressed under the
    // rotated parent. Without A2 it would be off by the parent's 90° (≈ [1,0,0]).
    expect(dir[0]).toBeCloseTo(0, 2);
    expect(dir[1]).toBeCloseTo(0, 2);
    expect(dir[2]).toBeCloseTo(1, 2);

    // Falsify: mute the Track-To → the box reverts to its authored rotation under
    // the parent (identity local → parent 90°Y → -Z = [-1,0,0]).
    await page.evaluate(() => {
      (window as unknown as W)
        .__basher_dag!.getState()
        .dispatch({ type: 'setParam', nodeId: 'n266_tt', paramPath: 'mute', value: true });
    });
    await page.waitForTimeout(300);
    const q2 = await page.evaluate(
      (tf) => (window as unknown as W).__basher_mesh_world_quaternion!(tf),
      TF,
    );
    const dir2 = norm(minusZ(q2!));
    expect(dir2[0]).toBeCloseTo(-1, 2);
    expect(dir2[2]).toBeCloseTo(0, 2);
  });

  test('nested direct channel animates the nested box world position (B1-B3)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_position);
    });
    await page.evaluate(
      ({ tf, box, boxOps }) => {
        const w = window as unknown as W;
        const d = (op: unknown) => w.__basher_dag!.getState().dispatch(op);
        w.__basher_time!.getState().pause();
        w.__basher_time!.getState().setTime(0);
        // #365 Slice 2: the nested box is a split cube; the Object keeps `box`, so the
        // nested position channel (target: box) drives the Object's own pose.
        for (const op of boxOps) d(op);
        d({
          type: 'addNode',
          nodeId: tf,
          nodeType: 'Transform',
          params: { position: [2, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
        });
        d({
          type: 'connect',
          from: { node: box, socket: 'out' },
          to: { node: tf, socket: 'target' },
        });
        d({
          type: 'connect',
          from: { node: tf, socket: 'out' },
          to: { node: 'n_scene', socket: 'children' },
        });
        // A free-floating channel on the NESTED box's local position: [0,0,0]→[0,5,0].
        d({
          type: 'addNode',
          nodeId: 'n266_ch',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'nbpos',
            target: box,
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 2, value: [0, 5, 0], easing: 'linear' },
            ],
          },
        });
      },
      { tf: TF, box: BOX, boxOps: splitCubeOps({ objectId: BOX, position: [0, 0, 0] }) },
    );
    await page.waitForTimeout(400);

    // t=0: box local [0,0,0] → world = parent [2,0,0].
    const p0 = await page.evaluate(
      (tf) => (window as unknown as W).__basher_mesh_world_position!(tf),
      TF,
    );
    expect(p0).not.toBeNull();
    expect(p0![0]).toBeCloseTo(2, 1);
    expect(p0![1]).toBeCloseTo(0, 1);

    // t=2: box local [0,5,0] → parent 90°Y rotates [0,5,0]→[0,5,0], + [2,0,0] = [2,5,0].
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.__basher_time!.getState().setTime(2);
    });
    await page.waitForFunction((tf) => {
      const p = (window as unknown as W).__basher_mesh_world_position!(tf);
      return p != null && Math.abs(p[1] - 5) < 0.2;
    }, TF);
    const p2 = await page.evaluate(
      (tf) => (window as unknown as W).__basher_mesh_world_position!(tf),
      TF,
    );
    expect(p2![0]).toBeCloseTo(2, 1);
    expect(p2![1]).toBeCloseTo(5, 1); // the nested channel animated it (was frozen at 0 before #266)
  });
});

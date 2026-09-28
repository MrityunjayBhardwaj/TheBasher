// #1213 — a motion dropped beside a native character binds to it, and the drawn skin plays it, in the
// running editor.
//
// Binding makes the retarget the source of the armature Object's pose chain, the one thing that poses
// a native rig, under the base layer holding the file's own keys, which the bind mutes (#1211). The
// motion is a two-joint swing named as the bar's bones, so the product's bind bridges it by matching
// names; it turns Bone1 by 45° at 0.5 s and 90° at 1 s about Z. Both rigs rest unrotated, so the bar's
// tip (resting at (0.2, 2, 0) in the file) must turn by those angles about Bone1's head (0, 1, 0).
// That oracle is arithmetic, not our code; the bar's own clip lands elsewhere ((−0.823, 1.602) at
// 0.5 s for the other top vertex, measured). Through
// the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
  meta?: { hidden?: boolean };
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

const SWING_BVH = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

/** The file-space tip, turned by `degrees` about Bone1's head (0, 1, 0). */
function turnedTip(degrees: number): [number, number, number] {
  const a = (degrees * Math.PI) / 180;
  const [x, y] = [0.2, 1];
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a) + 1, 0];
}

test('#1213 — a motion binds to the native bar and its drawn skin plays it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const outcome = await page.evaluate(async (bvh) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const bvhChain = await import('/src/core/import/bvhImportChain.ts');
    const standing = await import('/src/core/import/skeletonObject.ts');
    const bind = await import('/src/app/asset/bindMotionToCharacter.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const sceneNodeId = dag.state.outputs.scene!.node;
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1213/skinned-bar.glb',
      sceneNodeId,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const motion = bvhChain.buildBvhImportOps({
      text: bvh,
      name: 'swing',
      ids: { skeleton: 'p1213_swing_skel', layer: 'p1213_swing_motion' },
    });
    const bones = (motion.ops[0] as { params: { bones: never[] } }).params.bones;
    const stand = standing.buildSkeletonObjectOps({
      skeletonId: 'p1213_swing_skel',
      bones,
      sceneNodeId,
      normalise: false,
      name: 'swing',
      pose: { node: 'p1213_swing_motion', socket: 'out' },
      nameFollowsClip: false,
    });
    w.__basher_dag.getState().dispatchAtomic([...motion.ops, ...stand.ops], 'user', 'import bvh');
    const bound = bind.bindMotionToCharacter(
      { motionId: 'p1213_swing_motion', skeletonId: 'p1213_swing_skel' },
      'imported',
    );
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes[modifier].inputs.armature as { node: string }).node;
    // Object ← base layer (muted) ← retarget.
    const base = (nodes[armature].inputs.pose as { node: string }).node;
    return {
      bound,
      baseType: nodes[base].type,
      baseMuted: (nodes[base].params as { mute?: boolean }).mute === true,
      pose: nodes[base].inputs.pose,
      standInHidden: nodes[stand.objectId].meta?.hidden === true,
    };
  }, SWING_BVH);

  expect(outcome.bound.ok, JSON.stringify(outcome.bound)).toBe(true);
  expect(outcome.baseType).toBe('PoseLayer');
  expect(outcome.baseMuted, 'the bind mutes the file’s own motion').toBe(true);
  expect(outcome.pose).toMatchObject({ socket: 'posed' });
  expect(outcome.standInHidden, 'the motion’s own rig steps aside').toBe(true);

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);
  const seam = await page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return { tip, rest: s.rest(tip) };
  });
  // The import Group places the file; the drawn rest minus the file's rest is that placement.
  const offset = seam.rest.map((c, k) => c - [0.2, 2, 0][k]);

  for (const [t, degrees] of [
    [0, 0],
    [0.5, 45],
    [1, 90],
  ] as const) {
    await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const drawn = await page.evaluate(
      (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
      seam.tip,
    );
    const want = turnedTip(degrees);
    drawn.forEach((c, k) =>
      expect(c - offset[k], `drawn tip at ${t}s, axis ${k}`).toBeCloseTo(want[k], 3),
    );
  }
});

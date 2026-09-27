// #1215 — a director bakes a character's bound motion into keys from the inspector, and the drawn skin
// does not move: the retarget's poses become an override layer of keys at the bottom of the chain, the
// retarget is detached and kept, and one undo puts the live retarget back.
//
// Subject: skinned-bar.glb through the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's,
// with a two-joint swing bound onto it by the product's bind. The swing takes Bone1
// from 0° to 90° over a second, so the drawn skin is bent mid-way; a bake that keyed the wrong poses,
// or that the chain did not read, would draw it elsewhere.
import { test, expect } from './_fixtures';

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
      undo: () => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

const SWING = `HIERARCHY
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

test('#1215 — baking a bound motion to keys leaves the drawn skin where it was', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const armature = await page.evaluate(async (bvh) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const bvhChain = await import('/src/core/import/bvhImportChain.ts');
    const standing = await import('/src/core/import/skeletonObject.ts');
    const bind = await import('/src/app/asset/bindMotionToCharacter.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = () => w.__basher_dag.getState();
    const scene = dag().state.outputs.scene!.node;
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1215/skinned-bar.glb',
      sceneNodeId: scene,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag().dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const motion = bvhChain.buildBvhImportOps({
      text: bvh,
      name: 'swing',
      ids: { skeleton: 'swing_skel', layer: 'swing_motion' },
    });
    dag().dispatchAtomic(motion.ops, 'user', 'import bvh');
    const bones = dag().state.nodes.swing_skel.params.bones as never;
    const stand = standing.buildSkeletonObjectOps({
      skeletonId: 'swing_skel',
      bones,
      sceneNodeId: scene,
      normalise: false,
      name: 'swing',
      pose: { node: 'swing_motion', socket: 'out' },
      nameFollowsClip: false,
    });
    dag().dispatchAtomic(stand.ops, 'user', 'stand the motion');
    selection.useSelectionStore.getState().select(null);
    const bound = bind.bindMotionToCharacter(
      { motionId: 'swing_motion', skeletonId: 'swing_skel' },
      'imported',
    );
    if (!bound.ok) throw new Error(JSON.stringify(bound));
    const nodes = dag().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    selection.useSelectionStore.getState().select(id);
    return id;
  }, SWING);

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);

  const drawnAt = async (seconds: number) => {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    return page.evaluate(() => {
      const s = (window as unknown as W).__basher_gltf_skin!()!;
      return Array.from({ length: s.count }, (_, i) => ({ rest: s.rest(i), drawn: s.vertex(i) }));
    });
  };
  /** What feeds the bottom of the armature's pose chain. */
  const chainSource = () =>
    page.evaluate(async (id) => {
      const { poseLayerChain } = await import('/src/app/animate/poseChain.ts');
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
      const chain = poseLayerChain(nodes as never, id);
      return {
        source: chain.source,
        base: chain.base,
        retargets: Object.values(nodes).filter((n) => n.type === 'RetargetClip').length,
      };
    }, armature);

  const TIMES = [0.25, 0.5, 0.75];
  const before = [];
  for (const t of TIMES) before.push(await drawnAt(t));
  // Control: the swing bends the bar at 0.5 s, so a skin at rest or on the wrong pose shows below.
  const bent = Math.max(
    ...before[1].map((v) => Math.max(...v.drawn.map((c, k) => Math.abs(c - v.rest[k])))),
  );
  expect(bent, 'the bar is bent at 0.5 s').toBeGreaterThan(0.1);
  const bound = await chainSource();
  expect(bound.source?.socket).toBe('posed');

  const button = page.getByTestId('inspector-bake-pose-button');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByTestId('inspector-bake-pose-done')).toBeVisible();

  const baked = await chainSource();
  expect(baked.source, 'the chain stands on the rest pose now').toEqual({
    node: expect.any(String),
    socket: 'pose',
  });
  expect(baked.base, 'the baked layer is the chain’s base').not.toBeNull();
  expect(baked.retargets, 'the retarget is kept').toBe(bound.retargets);
  // Keys now: nothing computed left to bake.
  await expect(button).toBeHidden();

  for (const [i, t] of TIMES.entries()) {
    const after = await drawnAt(t);
    expect(after.length).toBe(before[i].length);
    after.forEach((v, n) =>
      v.drawn.forEach((c, k) =>
        expect(c, `vertex ${n} axis ${k} at ${t}s after the bake`).toBeCloseTo(
          before[i][n].drawn[k],
          4,
        ),
      ),
    );
  }

  // One undo: the live retarget drives the bar again.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect((await chainSource()).source).toEqual(bound.source);
  await expect(button).toBeVisible();
});

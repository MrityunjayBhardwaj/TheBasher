// #1244 — a director poses a bone of a native character from the inspector's pose row, and the
// drawn skin holds the pose across frames, in the running editor.
//
// The pose row writes through `mutator.animate.poseBone` anchored on the armature Object; the first
// pose inserts a pose layer between the bar's clip and the Object. The bar's clip keys Bone1 the whole
// way (0 → ~85°), so a pose that holds must override it at every frame. Oracle, arithmetic: Bone1's
// head is (0, 1, 0), and the tip (resting at (0.2, 2, 0) in the file) turned 90° about Z around it
// lands at (−1, 1.2, 0). The rotation is the verb's order (Blender ZYX); a single-axis Z turn is the
// same in every order. Through the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
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

const TURNED_TIP: [number, number, number] = [-1, 1.2, 0];

test('#1244 — the pose row poses a native bone, and the drawn skin holds it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1244/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    // What selecting the armature, entering Pose mode and clicking its bone does.
    selection.useSelectionStore.getState().select(id);
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
    // #1335 — a bone is live in Pose mode, which is where a director poses one.
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'pose');
    return id;
  });

  await expect(page.getByTestId('inspector-selected-bone-name')).toHaveValue('Bone1');
  await page.getByTestId('inspector-bone-pose-add').click();
  const z = page.getByTestId('inspector-bone-pose-rotation-z');
  await expect(z).toBeVisible();
  await z.fill('90');

  // The graph: a layer between the clip and the Object.
  const chain = await page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const feed = (nodes[id].inputs.pose as { node: string }).node;
    return {
      feedType: nodes[feed].type,
      below: (nodes[feed].inputs.pose as { node: string }).node,
    };
  }, armature);
  expect(chain.feedType).toBe('PoseLayer');

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
  const offset = seam.rest.map((c, k) => c - [0.2, 2, 0][k]);

  for (const t of [0.25, 0.9]) {
    await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const drawn = await page.evaluate(
      (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
      seam.tip,
    );
    drawn.forEach((c, k) =>
      expect(c - offset[k], `drawn tip at ${t}s, axis ${k}`).toBeCloseTo(TURNED_TIP[k], 3),
    );
  }
});

// #1208 — a glTF with two skins under two armature nodes comes across natively as two skeletons,
// each standing its own Object and posed by its own channels, as Blender 5.1.1 makes two armature
// Objects of it (ref/probes/blender-native-character/q1208_two_skins_oracle.py). Through
// the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's.
//
// The file: skinned-bar twice, the second rig at x = 3 bending the other way. At 0.5 s (frame 12)
// each rig's leaf bone Bone1 therefore points along (∓0.6756, 0.7373, 0) in glTF space.
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_armature?: {
    names: string[];
    matrices: number[][];
    skeletonObjects: { id: string; posed: boolean }[];
  };
}

test('#1208 — two skins stand as two rigs, each posed by its own channels', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const types = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/two-skinned-bars.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1208/two-skinned-bars.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, two skins)');
    return Object.values(w.__basher_dag.getState().state.nodes).map((n) => n.type);
  });
  expect(types.filter((t) => t === 'Skeleton')).toHaveLength(2);
  expect(types.filter((t) => t === 'ArmatureModifier')).toHaveLength(2);

  await page.waitForFunction(
    () => ((window as unknown as W).__basher_armature?.skeletonObjects.length ?? 0) >= 2,
  );
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0.5));
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const leaves = await page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature!;
    return a.names
      .map((name, i) => ({ name, m: a.matrices[i] }))
      .filter((b) => b.name === 'Bone1')
      .map(({ m }) => {
        const len = Math.hypot(m[4], m[5], m[6]);
        return { x: m[12], axis: [m[4] / len, m[5] / len, m[6] / len] };
      })
      .sort((p, q) => p.x - q.x);
  });
  expect(leaves).toHaveLength(2);
  // Rig A (left) bends toward −x, rig B (3 units right) toward +x.
  [-0.6756, 0.7373, 0].forEach((c, k) =>
    expect(leaves[0].axis[k], `A axis ${k}`).toBeCloseTo(c, 3),
  );
  [0.6756, 0.7373, 0].forEach((c, k) => expect(leaves[1].axis[k], `B axis ${k}`).toBeCloseTo(c, 3));
  expect(leaves[1].x - leaves[0].x).toBeCloseTo(3, 3);
  expect(errors).toEqual([]);
});

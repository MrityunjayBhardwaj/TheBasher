// #1342 — moving a joint in Edit mode and going back to Pose mode keeps the hand-pose on the same
// bone, and the mesh deforms from the new joint.
//
// The skinned bar: Bone1's head at (0, 1, 0), the bar's tip resting at (0.2, 2, 0) (p1244). Bone1 is
// hand-posed 90° about Z at 0 s, where the clip holds it at rest. Then its rest joint is raised to
// (0, 1.5, 0) in Edit mode, children following. Back in Pose mode the hand-pose still turns Bone1,
// now about the NEW head: the tip, 0.5 above it and 0.2 out, turns to (−0.5, 0.2, 0) about it and
// lands at (−0.5, 1.7, 0). Before the joint moved it landed at (−1, 1.2, 0) (p1244's oracle).

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

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
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    count: number;
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

async function tip(page: Page): Promise<number[]> {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
    .toBe(true);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let i = 0;
    for (let k = 1; k < s.count; k++) {
      const r = s.rest(k);
      const best = s.rest(i);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) i = k;
    }
    const rest = s.rest(i);
    return s.vertex(i).map((c, k) => c - rest[k] + [0.2, 2, 0][k]);
  });
}

test('#1342 — a joint moved in Edit mode keeps its hand-pose, and the skin bends from the new joint', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1342/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const mod = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    w.__basher_time.getState().setTime(0);
    return (nodes[mod].inputs.armature as { node: string }).node;
  });
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0, 1.2, 0);
    t.camera.position.set(0, 1.2, 5);
  });
  await page.getByTestId(`scene-tree-row-${armature}`).click();
  await page.getByTestId('armature-mode').selectOption('pose');
  await page.evaluate(async (id) => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
  }, armature);

  // The hand-pose, from the panel.
  await page.getByTestId('inspector-bone-pose-add').click();
  await page.getByTestId('inspector-bone-pose-rotation-z').fill('90');
  const before = await tip(page);
  before.forEach((c, k) => expect(c, `posed tip ${k}, before`).toBeCloseTo([-1, 1.2, 0][k], 3));
  await page.screenshot({ path: test.info().outputPath('1-posed-before.png') });

  // Edit mode: raise Bone1's rest joint to y = 1.5 from the panel, children following.
  await page.getByTestId('armature-mode').selectOption('edit');
  await expect(page.getByTestId('edit-bone')).toBeVisible();
  await page.getByTestId('edit-bone-position-y').fill('1.5');

  // Back to Pose mode: the hand-pose is still Bone1's, and bends the bar about the new joint.
  await page.getByTestId('armature-mode').selectOption('pose');
  await expect(page.getByTestId('inspector-bone-pose-rotation-z')).toHaveValue('90');
  const after = await tip(page);
  await page.screenshot({ path: test.info().outputPath('2-posed-after.png') });
  after.forEach((c, k) => expect(c, `posed tip ${k}, after`).toBeCloseTo([-0.5, 1.7, 0][k], 3));
});

// #1474 — "pose this bone" on a moving bone leaves the drawn skin as it was at the playhead.
//
// The skinned bar's clip turns Bone1 from 0 to ~85° about Z over its second. At 0.6 s the bar is
// bent; clicking "pose this bone" used to seed rotation 0, which snapped the bar straight. Now the
// member starts from the rotation shown, so every skin vertex stays put (the issue's bound: < 1e-5).

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

const T = 0.6;

/** Every drawn skin vertex, and its rest, after two frames have drawn. */
async function skin(page: Page): Promise<{ drawn: number[][]; rest: number[][] }> {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
    .toBe(true);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    const drawn: number[][] = [];
    const rest: number[][] = [];
    for (let i = 0; i < s.count; i++) {
      drawn.push(s.vertex(i));
      rest.push(s.rest(i));
    }
    return { drawn, rest };
  });
}

const maxDelta = (a: number[][], b: number[][]) =>
  Math.max(...a.flatMap((v, i) => v.map((c, k) => Math.abs(c - b[i][k]))));

test('#1474 — "pose this bone" on a moving bone leaves the skin where it is drawn', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  // #1523 — this spec writes the camera by hand: wait out the boot view fit, which would land after.
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const armature = await page.evaluate(async (t) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1474/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const mod = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    w.__basher_time.getState().setTime(t);
    return (nodes[mod].inputs.armature as { node: string }).node;
  }, T);
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

  const before = await skin(page);
  // Not vacuous: at 0.6 s the clip has bent the bar away from its rest.
  expect(maxDelta(before.drawn, before.rest)).toBeGreaterThan(0.1);
  await page.screenshot({ path: test.info().outputPath('1-before-click.png') });

  await page.getByTestId('inspector-bone-pose-add').click();
  // The member exists once the row shows its fields.
  await expect(page.getByTestId('inspector-bone-pose-rotation-z')).toBeVisible();

  const after = await skin(page);
  await page.screenshot({ path: test.info().outputPath('2-after-click.png') });
  expect(maxDelta(after.drawn, before.drawn)).toBeLessThan(1e-5);
  // It holds the rotation that was shown (~51° about Z), not 0.
  expect(
    Number(await page.getByTestId('inspector-bone-pose-rotation-z').inputValue()),
  ).toBeGreaterThan(30);
});

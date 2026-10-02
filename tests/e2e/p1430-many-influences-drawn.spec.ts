// #1430 — a mesh with points bound to more than four bones draws in the live app exactly as the
// Armature modifier deforms it, which is where Blender puts it.
//
// WHICH ROAD THIS TAKES. Like p1197, this builds the native ops with the product's reader
// (`buildNativeGltfImportOps`, loaded as a dev-server module) and dispatches them into the live
// editor: it witnesses the DRAW. three's skinning shader sums four bones per vertex, so this mesh
// is not skinned on the GPU; its buffers are written from the deform (`buildDeformedDraw`).
//
// The oracle: Blender 5.1.1 on the same file (`scripts/gen-many-influence-fixture.mjs` writes it),
// every vertex at frames 12 and 24 (24 fps), in glTF space, keyed by where the vertex rests.
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface SkinSeam {
  boneCount: number;
  bound: boolean;
  count: number;
  rest: (i: number) => [number, number, number];
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, { type: string }> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinSeam | null;
}

/** Blender's vertices by rest position `x,y`: at 0.5 s and at 1 s. */
const BLENDER: Record<string, Record<number, [number, number, number]>> = {
  // Five bones.
  '0,2': { 0.5: [-0.191784, 1.431651, 0], 1: [-0.108796, 0.871343, 0] },
  // Six bones.
  '1,2': { 0.5: [0.749267, 1.71226, 0], 1: [0.674076, 1.370771, 0] },
  // One bone each: the still root, and B5.
  '0,0': { 0.5: [0, 0, 0], 1: [0, 0, 0] },
  '1,0': { 0.5: [1.918731, -0.706495, 0], 1: [3.077697, -0.707708, 0] },
};

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time.getState().setTime(s),
    seconds,
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test('#1430 — a five- and a six-bone vertex are drawn where Blender deforms them', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag?.getState().state.outputs.scene && w.__basher_time);
  });

  const layers = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-many-influences.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1430/skinned-many-influences.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    // Before #1430 this file was refused for its second joint set.
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, many influences)');
    const data = result.ops.find(
      (op: { type: string; nodeType?: string }) =>
        op.type === 'addNode' && op.nodeType === 'PolyMeshData',
    ) as { params: { mesh: { pointLayers: { name: string }[] } } };
    return data.params.mesh.pointLayers.map((layer) => layer.name);
  });
  expect(layers).toEqual(['skin_joints', 'skin_weights', 'skin_joints_1', 'skin_weights_1']);

  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    { timeout: 15_000 },
  );
  const seam = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    return {
      boneCount: s.boneCount,
      bound: s.bound,
      rest: Array.from({ length: s.count }, (_, i) => s.rest(i)),
    };
  });
  expect(seam.bound).toBe(true);
  expect(seam.boneCount).toBe(6);
  // The import Group places the model by its pivot: the drawn rest is the file's point plus that
  // offset, read off the vertex the file rests at the origin.
  const lowest = seam.rest.reduce((a, b) => (b[0] + b[1] < a[0] + a[1] ? b : a));
  const keyOf = (r: number[]) => `${Math.round(r[0] - lowest[0])},${Math.round(r[1] - lowest[1])}`;
  expect([...new Set(seam.rest.map(keyOf))].sort()).toEqual(Object.keys(BLENDER).sort());

  for (const t of [0.5, 1]) {
    await setTime(page, t);
    const drawn = await page.evaluate(() => {
      const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
      return Array.from({ length: s.count }, (_, i) => s.vertex(i));
    });
    drawn.forEach((v, i) => {
      const want = BLENDER[keyOf(seam.rest[i])][t];
      v.forEach((c, k) =>
        expect(
          c - lowest[k],
          `vertex resting at ${keyOf(seam.rest[i])}, ${t} s, axis ${k}`,
        ).toBeCloseTo(want[k], 3),
      );
    });
  }
  // Back at 0 s every vertex is where it rests.
  await setTime(page, 0);
  const back = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    return Array.from({ length: s.count }, (_, i) => [s.vertex(i), s.rest(i)]);
  });
  back.forEach(([v, r]) => v.forEach((c, k) => expect(c).toBeCloseTo(r[k], 5)));
  expect(errors).toEqual([]);
});

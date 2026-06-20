// glTF direct-import (V53) — KHR_texture_transform (tiling/offset/rotation) is
// captured into the IR's shared `uvTransform` (when uniform across a material's
// textures) AND applied to the overlay's clone textures, so a tiled/offset glTF
// texture is DAG-addressable + editable, not just clone-rendered.
//
// BOUNDARY-PAIR PROOF: import uv-transform-quad (baseColorTexture scale [2,3]
// offset [0.1,0.2]) →
//   side A (DAG)   — the GltfChild material's uvTransform = {tiling:[2,3], offset:[0.1,0.2]}.
//   side B (clone) — the rendered base map's repeat=[2,3], offset=[0.1,0.2] (identity
//                    with GLTFLoader — center [0,0]; Basher's apply matched it).

import { test, expect } from './_fixtures';

interface MeshSummary {
  mapRepeat: [number, number] | null;
  mapOffset: [number, number] | null;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

const capturedUv = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const child = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && Array.isArray(n.params.materials),
    );
    const mats = child?.params.materials as
      | { uvTransform?: { tiling: number[]; offset: number[]; rotation: number } }[]
      | undefined;
    return mats?.[0]?.uvTransform ?? null;
  });

const firstMesh = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [])[0] ?? null;
  });

test('captures KHR_texture_transform into uvTransform; clone map matches (identity)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/uv-transform-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'uv-transform-quad.gltf', bytes }], 'uvt');
  });

  // side A — captured into the shared uvTransform (tiling = scale, offset).
  await expect.poll(async () => (await capturedUv(page))?.tiling).toEqual([2, 3]);
  expect((await capturedUv(page))?.offset).toEqual([0.1, 0.2]);

  // side B — the rendered clone's base map carries the SAME repeat/offset
  // (Basher's apply reproduced GLTFLoader's transform → byte-identical render).
  await expect.poll(async () => (await firstMesh(page))?.mapRepeat).toEqual([2, 3]);
  const m = await firstMesh(page);
  expect(m?.mapOffset?.[0]).toBeCloseTo(0.1);
  expect(m?.mapOffset?.[1]).toBeCloseTo(0.2);

  // EDITABLE: changing the DAG uvTransform.tiling re-overlays the clone's map →
  // proves the apply is LIVE (not merely the clone's original GLTFLoader transform).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const child = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && Array.isArray(n.params.materials),
    )!;
    const mats = (child.params.materials as { uvTransform: Record<string, unknown> }[]).map((mm, i) =>
      i === 0 ? { ...mm, uvTransform: { ...mm.uvTransform, tiling: [5, 5] } } : mm,
    );
    w.__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: child.id, paramPath: 'materials', value: mats }],
        'user',
        'edit uvTransform tiling',
      );
  });
  await expect.poll(async () => (await firstMesh(page))?.mapRepeat).toEqual([5, 5]);
});

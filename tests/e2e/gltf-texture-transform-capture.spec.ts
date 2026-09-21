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
//
// #1123 — a drop or the picker now brings this file across NATIVE, so the clone half above is pinned
// to `__basher_importGltf`, the entry that never tries native. The clone road still carries this
// capture for any file the native road refuses (a transformed map beside sheen, say). The native
// half restates the placement about the native material's centre pivot, so its OFFSET differs from
// the file's; what must not differ is the UV matrix three draws with, which is what it asserts.

import { test, expect } from './_fixtures';
import { firstMaterialChild } from './_importedChild';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

interface MeshSummary {
  mapRepeat: [number, number] | null;
  mapOffset: [number, number] | null;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_importGltf: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes: (ref: string, bytes: Uint8Array) => Promise<void>;
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

// #389 — the captured table moved to the `GltfData` half; see `_importedChild`.
const capturedUv = async (page: import('@playwright/test').Page) => {
  const child = await firstMaterialChild(page);
  return (
    (
      child?.slots[0] as
        | { uvTransform?: { tiling: number[]; offset: number[]; rotation: number } }
        | undefined
    )?.uvTransform ?? null
  );
};

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
    () => typeof (window as unknown as BasherWindow).__basher_importGltf === 'function',
  );
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const buffer = await fetch('/assets/uv-transform-quad.gltf').then((r) => r.arrayBuffer());
    await w.__basher_writeOpfsBytes('assets/uv-transform-quad.gltf', new Uint8Array(buffer));
    await w.__basher_importGltf(buffer, 'assets/uv-transform-quad.gltf');
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
  // #389 — slot 0 IS `material` on the `GltfData` half, so the edit is a whole-`material`
  // replace on that node rather than a map over a `materials` array on the fused child.
  const dataId = (await firstMaterialChild(page))!.dataId;
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const mat = w.__basher_dag.getState().state.nodes[id].params.material as {
      uvTransform: Record<string, unknown>;
    };
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: id,
          paramPath: 'material',
          value: { ...mat, uvTransform: { ...mat.uvTransform, tiling: [5, 5] } },
        },
      ],
      'user',
      'edit uvTransform tiling',
    );
  }, dataId);
  await expect.poll(async () => (await firstMesh(page))?.mapRepeat).toEqual([5, 5]);
});

// three's `Matrix3.setUvTransform` for the file's placement about the UV origin: scale [2,3] on the
// diagonal, offset [0.1,0.2] in the translation column (column-major).
const FILE_UV_MATRIX = [2, 0, 0, 0, 3, 0, 0.1, 0.2, 1];

function expectMatrix(got: number[] | null | undefined, want: number[]): void {
  expect(got).toHaveLength(9);
  for (let i = 0; i < 9; i++) expect(got![i]).toBeCloseTo(want[i], 9);
}

test('#1123 — a drop brings it across native, drawing the same UV matrix the file asks for', async ({
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

  // side A — native mesh data, its placement restated about the centre: tiling and rotation as the
  // file wrote them, offset moved by (tiling − 1)·0.5.
  await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');
  const mesh = (await firstMaterialMesh(page))!;
  const uv = (mesh.slots[0] as { uvTransform: { tiling: number[]; offset: number[] } }).uvTransform;
  expect(uv.tiling).toEqual([2, 3]);
  expect(uv.offset[0]).toBeCloseTo(0.6, 9);
  expect(uv.offset[1]).toBeCloseTo(1.2, 9);

  // side B — what is drawn: the base map's UV matrix is the file's, exactly as the clone road draws.
  await expect
    .poll(async () => (await drawnImportMeshes(page, mesh.rootId))[0]?.mapUvMatrix ?? null)
    .not.toBeNull();
  expectMatrix((await drawnImportMeshes(page, mesh.rootId))[0].mapUvMatrix, FILE_UV_MATRIX);

  // EDITABLE — tiling [5,5] on the mesh data re-places the drawn map about the centre.
  await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const mat = w.__basher_dag.getState().state.nodes[id].params.material as {
      uvTransform: Record<string, unknown>;
    };
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: id,
          paramPath: 'material',
          value: { ...mat, uvTransform: { ...mat.uvTransform, tiling: [5, 5] } },
        },
      ],
      'user',
      'edit uvTransform tiling',
    );
  }, mesh.dataId);
  await expect
    .poll(async () => (await drawnImportMeshes(page, mesh.rootId))[0]?.mapUvMatrix?.[0])
    .toBe(5);
  // translation = −5·0.5 + 0.5 + offset, about the centre.
  expectMatrix((await drawnImportMeshes(page, mesh.rootId))[0].mapUvMatrix, [
    5,
    0,
    0,
    0,
    5,
    0,
    -2 + 0.6,
    -2 + 1.2,
    1,
  ]);
});

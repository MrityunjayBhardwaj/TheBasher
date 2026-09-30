// glTF direct-import (V53) — KHR_texture_transform (tiling/offset/rotation) is captured into the
// material's placement, so a tiled/offset glTF texture is DAG-addressable and editable.
//
// #1123 — a drop or the picker brings this file across NATIVE. The native material restates the
// placement about its centre pivot, so its OFFSET differs from the file's; what must not differ is
// the UV matrix three draws with, which is what the case asserts. (#1053 retired the clone road's
// case here: the clone renderer that drew it is gone.)

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

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

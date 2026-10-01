// #1381 — a glTF file's tangents come across a native import by being checked against MikkTSpace
// and dropped, in the browser the product runs in.
//
// The unit rows run MikkTSpace in Node. Here it runs where it ships: three's bundled wasm
// (`three/examples/jsm/libs/mikktspace.module.js`), instantiated from its inline data URI by the
// page itself. The fixture is the geometry of Khronos's `NormalTangentMirrorTest` (CC BY 4.0): 15,720
// corners of authored tangents, mirrored UV islands included. Before this, the file was refused
// ("carries TANGENT, which a native mesh has no buffer slot to draw").
//
// REF: src/core/import/nativeGltfImport.ts (`unreproducedTangents`, `DERIVED_ATTRIBUTES`); issue #1381.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

const FIXTURE = 'tangent-mirror.glb';

interface Win {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<Win>).__basher_ingestGltfFolder),
  );
}

test('#1381 — a file with authored tangents imports native, holding no tangents', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await ready(page);
  const outcome = await page.evaluate(async (file) => {
    const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
    try {
      return await (window as unknown as Win).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        'p1381',
      );
    } catch (e) {
      return `threw: ${String(e)}`;
    }
  }, FIXTURE);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nodes = Object.values((window as unknown as Win).__basher_dag.getState().state.nodes);
        return nodes
          .filter((n) => n.type === 'PolyMeshData' || n.type === 'GltfData')
          .map((n) => n.type);
      }),
    )
    .toEqual(['PolyMeshData']);
  const layers = await page.evaluate(() => {
    const data = Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'PolyMeshData',
    )!;
    const mesh = data.params.mesh as {
      cornerLayers: { name: string }[];
      faceSizes: unknown;
    };
    return mesh.cornerLayers.map((l) => l.name);
  });
  expect(layers).toEqual(['UVMap']);
  expect(typeof outcome).toBe('string');
  expect(String(outcome)).not.toContain('threw');
  expect(errors).toEqual([]);
});

// #1384 — a static glTF mesh that carries joints and weights but that no node skins imports native,
// holding neither, and says what it left behind.
//
// Before this, the file was refused ("carries JOINTS_0, but no node skins it"). Blender reads joint
// sets only for a skinned mesh (`io_scene_gltf2/blender/imp/mesh.py:92`, 5.1.1) and drops them
// otherwise; so does the import now (user decision 2026-09-30), with a console notice — the
// surface the import's other no-silent-drop repairs use, since the import succeeded.
//
// REF: src/core/import/nativeGltfImport.ts (`SKIN_SET`, `notices`); src/app/asset/importGltf.ts
//      (`leftBehindNotice`); issue #1384.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

const FIXTURE = 'cube-stray-joints.gltf';

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

test('#1384 — an unskinned mesh with joint sets imports, holds none, and says so', async ({
  page,
}) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto('/');
  await ready(page);
  await page.evaluate(async (file) => {
    const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
    await (window as unknown as Win).__basher_ingestGltfFolder(
      [{ relativePath: file, bytes }],
      'p1384',
    );
  }, FIXTURE);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).filter(
            (n) => n.type === 'PolyMeshData',
          ).length,
      ),
    )
    .toBe(1);
  const held = await page.evaluate(() => {
    const data = Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'PolyMeshData',
    )!;
    const mesh = data.params.mesh as { pointLayers: unknown[]; vertexGroups: unknown[] };
    return { pointLayers: mesh.pointLayers.length, vertexGroups: mesh.vertexGroups.length };
  });
  expect(held).toEqual({ pointLayers: 0, vertexGroups: 0 });
  await expect
    .poll(() => warnings.filter((w) => w.includes('Left behind:')))
    .toEqual([
      expect.stringContaining(
        'mesh 0 carries JOINTS_0, WEIGHTS_0, but no node skins it, so they were dropped (as Blender drops them)',
      ),
    ]);
  expect(errors).toEqual([]);
});

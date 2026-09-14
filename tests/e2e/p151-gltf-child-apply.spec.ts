// p151 (Apply-Transform) — the imported-mesh boundary-pair gate (issue #151).
//
// Apply bakes an imported mesh's pose into its verts and writes a baked pair that has to
// look exactly like what was on screen, survive undo, not disturb any other import, and
// outlive the folder it was imported from. Every one of those is an OBSERVATION here, read
// off the real three.js render objects, never inferred from params.
//
// SC-2  verts (H40): baked world bounds == resolver baked bounds == original world bounds.
// SC-6  lossless material: the baked mesh draws the same textured material.
// SC-7  H45 isolation: baking one import leaves a second import of the SAME file unchanged.
// SC-5  undo: Apply → undo → the imported Object and its mesh data restored, no BakedData.
// M8    self-contained: bake → delete the imported folder → reload → still drawn textured.
//
// ── #1073: THE IMPORT IS NATIVE GEOMETRY NOW ─────────────────────────────────────────
//
// The fixture arrives as an ordinary `Object` over `PolyMeshData` (#1050), so Apply takes the
// generic bake road, not the glTF-child dispatcher. Two checks that belonged to the clone road
// are gone with it: "the source child is suppressed in the asset clone" (there is no clone,
// and the bake replaces the data in place under the same Object id) and the clone
// texture-readback probe. SC-7 isolation STAYS: two imports of one file share one
// content-addressed mesh in the geometry registry, so a bake that mutated the shared instance
// would corrupt the other import exactly as it would have corrupted a shared clone.
//
// ⚠️ SC-6 AND M8 ARE RED UNTIL #1077: the generic bake keeps only the base colour of an inline
// material and resets every other scalar and every map (measured: roughness 0.8 → 0.5, base map
// gone). The spec asserts the promise, not today's behaviour.
//
// REF: src/app/animate/dispatchApplyTransform.ts (the generic bake road),
//      tests/e2e/_importedMesh.ts (lookup + drawn reader); issues #151, #1073, #1077.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importRoots, importedMeshes } from './_importedMesh';

interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs?: Record<string, unknown> }
        >;
      };
      undo: () => void;
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_baked_geometry_bounds?: (nodeId: string) => [number, number, number] | null;
}

const FIXTURE = [
  { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
  { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
  { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
];

async function ingest(page: Page, folderName: string): Promise<void> {
  await page.evaluate(
    async ({ files: f, name }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const spec of f) {
        const buf = await fetch(spec.urlPath).then((r) => r.arrayBuffer());
        files.push({ relativePath: spec.relativePath, bytes: new Uint8Array(buf) });
      }
      await w.__basher_ingestGltfFolder!(files, name);
    },
    { files: FIXTURE, name: folderName },
  );
}

/** The import at `index` in scene order: its root, its Object, and the road it took. */
async function importNamed(page: Page, index: number) {
  const roots = await importRoots(page);
  const root = roots[index];
  if (!root) throw new Error(`no import root at index ${index}; roots: ${JSON.stringify(roots)}`);
  const mesh = (await importedMeshes(page)).find((m) => m.rootId === root.rootId);
  if (!mesh) throw new Error(`import root ${root.rootId} holds no mesh`);
  return { rootId: root.rootId, objectId: mesh.objectId, dataId: mesh.dataId, road: root.road };
}

/** Poll until the mesh drawn under `rootId` has a decoded base map, and return it. */
async function waitTextured(page: Page, rootId: string) {
  await expect
    .poll(async () => (await drawnImportMeshes(page, rootId)).some((m) => m.hasMap && m.mapImageOk))
    .toBe(true);
  return (await drawnImportMeshes(page, rootId))[0];
}

/** The Object posing a `BakedData`, found by POSSESSION rather than a type name (#388). */
function bakedPairOf(page: Page, objectId: string) {
  return page.evaluate((id) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const data = (nodes[id]?.inputs?.data as { node?: string } | undefined)?.node;
    if (!data || nodes[data]?.type !== 'BakedData') return null;
    return { id, dataId: data, params: nodes[id].params };
  }, objectId);
}

const nodeTypes = (page: Page) =>
  page.evaluate(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).map(
      (n) => n.type,
    ),
  );

async function applyTransform(page: Page, id: string) {
  return page.evaluate(async (nodeId) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return mod.dispatchApplyTransform(nodeId, 'all');
  }, id);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* absent */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_baked_geometry_bounds,
    );
  });
});

test('SC-2/SC-6: bake a textured imported mesh → three-way verts + lossless material', async ({
  page,
}) => {
  await ingest(page, 'p151-child');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  expect(imp.road).toBe('native');
  await waitTextured(page, imp.rootId);
  // A non-identity pose, so the bake has something to apply: at identity all three legs read
  // the same whether or not the pose reached the verts.
  await page.evaluate((id) => {
    (window as unknown as BasherWindow)
      .__basher_dag!.getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: id, paramPath: 'scale', value: [2, 1, 1] }],
        'user',
        'p151 pose',
      );
  }, imp.objectId);
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0])
    .toBeCloseTo(2, 3);
  const before = (await drawnImportMeshes(page, imp.rootId))[0];
  // Original world bounds — the THIRD leg of the three-way boundary-pair.
  const origBounds = before.worldBounds;

  const result = await applyTransform(page, imp.objectId);
  expect(result.ok).toBe(true);

  // The Object keeps its id and now poses a BakedData; the PolyMeshData is gone.
  await expect.poll(async () => (await bakedPairOf(page, imp.objectId)) !== null).toBe(true);
  const baked = (await bakedPairOf(page, imp.objectId))!;
  expect(baked.params.scale).toEqual([1, 1, 1]);
  expect(await nodeTypes(page)).not.toContain('PolyMeshData');

  // SC-2 — THREE-way verts boundary-pair (H40): rendered baked == resolver baked ==
  // original world bounds.
  await expect.poll(async () => (await drawnImportMeshes(page, imp.rootId)).length).toBe(1);
  const renderedBaked = (await drawnImportMeshes(page, imp.rootId))[0].worldBounds;
  const resolverBaked = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_baked_geometry_bounds!(id),
    baked.id,
  );
  console.log(
    'P151 VERTS three-way =',
    JSON.stringify({ origBounds, renderedBaked, resolverBaked }),
  );
  expect(resolverBaked).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(renderedBaked[i]).toBeCloseTo(resolverBaked![i], 3); // side A == side B
    expect(renderedBaked[i]).toBeCloseTo(origBounds[i], 2); // == the original
  }

  // SC-6 — lossless material on the drawn baked mesh (red until #1077).
  const bakedMat = await waitTextured(page, imp.rootId);
  console.log('P151 BAKED MATERIAL =', JSON.stringify(bakedMat));
  expect(bakedMat.mapColorSpace).toBe('srgb'); // base map sRGB (M5)
  expect(bakedMat.color).toBe(before.color); // resolved colour preserved
  expect(bakedMat.roughness).toBe(before.roughness); // scalars preserved
});

test('SC-7 isolation (H45): baking one import leaves a second import of the same file unchanged', async ({
  page,
}) => {
  await ingest(page, 'p151-iso-a');
  await ingest(page, 'p151-iso-b');
  await expect.poll(async () => (await importRoots(page)).length).toBe(2);
  const a = await importNamed(page, 0);
  const b = await importNamed(page, 1);
  expect([a.road, b.road]).toEqual(['native', 'native']);
  const bBefore = await waitTextured(page, b.rootId);
  const bScaleBefore = await page.evaluate(
    (id) =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id].params.scale,
    b.objectId,
  );

  // Give A a non-identity pose, so a bake that wrote into the shared geometry instance would
  // change what B draws — an identity bake would leave B's bounds equal either way.
  await page.evaluate((id) => {
    (window as unknown as BasherWindow)
      .__basher_dag!.getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: id, paramPath: 'scale', value: [2, 1, 1] }],
        'user',
        'p151 pose A',
      );
  }, a.objectId);

  const result = await applyTransform(page, a.objectId);
  expect(result.ok).toBe(true);
  await expect.poll(async () => (await bakedPairOf(page, a.objectId)) !== null).toBe(true);

  // B's Object and mesh data are untouched in the DAG.
  const bAfter = await page.evaluate(
    ({ objectId, dataId }) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return { scale: nodes[objectId]?.params.scale, dataType: nodes[dataId]?.type ?? null };
    },
    { objectId: b.objectId, dataId: b.dataId },
  );
  expect(bAfter.scale).toEqual(bScaleBefore);
  expect(bAfter.dataType).toBe('PolyMeshData');

  // B still draws at its pre-bake size (shared geometry not corrupted by A's bake).
  const bDrawn = await drawnImportMeshes(page, b.rootId);
  expect(bDrawn.length).toBe(1);
  for (let i = 0; i < 3; i++)
    expect(bDrawn[0].worldBounds[i]).toBeCloseTo(bBefore.worldBounds[i], 3);
});

test('SC-5 undo: Apply → Cmd+Z → the imported Object and its mesh data restored + BakedData gone', async ({
  page,
}) => {
  await ingest(page, 'p151-undo');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  await waitTextured(page, imp.rootId);
  await applyTransform(page, imp.objectId);
  await expect.poll(async () => (await bakedPairOf(page, imp.objectId)) !== null).toBe(true);

  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());

  const restored = await page.evaluate(
    ({ objectId, dataId }) => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return {
        objectType: nodes[objectId]?.type ?? null,
        poses: (nodes[objectId]?.inputs?.data as { node?: string } | undefined)?.node ?? null,
        dataType: nodes[dataId]?.type ?? null,
        hasBaked: Object.values(nodes).some((n) => n.type === 'BakedData'),
      };
    },
    { objectId: imp.objectId, dataId: imp.dataId },
  );
  expect(restored.objectType).toBe('Object');
  expect(restored.poses).toBe(imp.dataId); // the Object poses its mesh data again
  expect(restored.dataType).toBe('PolyMeshData');
  expect(restored.hasBaked).toBe(false);

  // …and the restored mesh draws textured again.
  await waitTextured(page, imp.rootId);
});

test('M8 self-contained: bake → delete the imported folder → reload → baked still renders textured', async ({
  page,
}) => {
  await ingest(page, 'p151-selfcontained');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  await waitTextured(page, imp.rootId);
  await applyTransform(page, imp.objectId);
  await expect.poll(async () => (await bakedPairOf(page, imp.objectId)) !== null).toBe(true);

  // Delete the imported folder via the SAME path the app uses — the My-Imports ︙ Delete
  // affordance routes through `deleteImportedAsset(name, {breakRefs})`. After this the file's
  // bytes are GONE, so anything that still reached back into `user-imports/` would lose its map
  // on the reload below.
  const deletion = await page.evaluate(async () => {
    const importCommon = await import('/src/app/asset/importCommon.ts');
    const boot = await import('/src/app/boot.ts');
    const NAME = 'p151-selfcontained';
    const storage = await boot.getStorage();
    const dir = `${importCommon.USER_IMPORTS_ROOT}/${NAME}`;
    const sourceFilesBefore = (await importCommon.listFilesDeep(storage, dir)).length;
    const result = await importCommon.deleteImportedAsset(NAME, { breakRefs: true });
    const sourceFilesAfter = (await importCommon.listFilesDeep(storage, dir)).length;
    return { deleted: result.deleted, sourceFilesBefore, sourceFilesAfter };
  });
  // A real before(>0) → after(0) transition, not a never-existed dir reading empty.
  expect(deletion.deleted).toBe(true);
  expect(deletion.sourceFilesBefore).toBeGreaterThan(0);
  expect(deletion.sourceFilesAfter).toBe(0);
  // The baked pair is still in the scene: a native import holds nothing that referenced the folder.
  expect(await bakedPairOf(page, imp.objectId)).not.toBeNull();

  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });

  await expect.poll(async () => (await bakedPairOf(page, imp.objectId)) !== null).toBe(true);
  // The textured baked mesh survives the reload (red until #1077: the bake drops the map).
  await waitTextured(page, imp.rootId);
});

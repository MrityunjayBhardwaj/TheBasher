// p151 (Apply-Transform) — the imported-mesh boundary-pair gate (issue #151).
//
// Apply moves an imported mesh's pose into its mesh data, and what it leaves has to look exactly
// like what was on screen, survive undo, not disturb any other import, and outlive the folder it
// was imported from. Every one of those is an OBSERVATION here, read off the real three.js render
// objects, never inferred from params.
//
// SC-2  verts (H40): drawn world bounds == stored-mesh bounds == original world bounds.
// SC-6  lossless material: the mesh draws the same textured material after Apply.
// SC-7  H45 isolation: applying on one import leaves a second import of the SAME file unchanged.
// SC-5  undo: Apply → undo → the original mesh data and pose restored, still textured.
// M8    self-contained: Apply → delete the imported folder → reload → still drawn textured.
// stacked  Apply under an Array modifier reaches the mesh data, keeps the modifier and the material.
//
// ── #1073 / #1077: THE IMPORT IS NATIVE GEOMETRY, AND APPLY KEEPS IT THAT WAY ───────────────
//
// The fixture arrives as an ordinary `Object` over `PolyMeshData` (#1050). Apply writes the pose
// into that `PolyMeshData` and resets the Object's pose; it never bakes, so there is no `BakedData`
// and the material is never re-expressed (#1077 — the bake used to keep only the base colour).
// Blender does the same: after Apply the object keeps the same Mesh datablock and material.
// SC-7 isolation STAYS: two imports of one file share one content-addressed mesh in the geometry
// registry, so an Apply that mutated the shared instance would corrupt the other import.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`applyIntoStoredMesh`),
//      tests/e2e/_importedMesh.ts (lookup + drawn reader); issues #151, #1073, #1077.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importRoots, importedMeshes } from './_importedMesh';
import { modifierChainOps } from './_modifierStack';

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

/**
 * What an Object poses, read through its `data` edge: the data node's id, type, packed mesh and
 * material, plus the Object's own pose. Reached by the edge, never by id spelling (#388).
 */
function posedDataOf(page: Page, objectId: string) {
  return page.evaluate((id) => {
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const dataId = (nodes[id]?.inputs?.data as { node?: string } | undefined)?.node ?? null;
    const data = dataId ? nodes[dataId] : undefined;
    return {
      dataId,
      dataType: data?.type ?? null,
      mesh: (data?.params.mesh ?? null) as unknown,
      material: (data?.params.material ?? null) as unknown,
      pose: {
        position: nodes[id]?.params.position,
        rotation: nodes[id]?.params.rotation,
        scale: nodes[id]?.params.scale,
      },
    };
  }, objectId);
}

/**
 * The stored mesh's own axis-aligned size, decoded by the product's reader: the MODEL leg of the
 * verts boundary-pair. Only comparable to a world size while the Object sits at identity, which
 * is what an Apply-all leaves.
 */
function storedMeshSize(page: Page, dataId: string) {
  return page.evaluate(async (id) => {
    const { unpackMeshData } = await import('/src/app/meshGeometryData.ts');
    const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
    const { points } = unpackMeshData(nodes[id].params.mesh as never);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) {
      min[i % 3] = Math.min(min[i % 3], points[i]);
      max[i % 3] = Math.max(max[i % 3], points[i]);
    }
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number];
  }, dataId);
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

async function setScale(page: Page, id: string, value: [number, number, number]) {
  await page.evaluate(
    ({ nodeId, v }) => {
      (window as unknown as BasherWindow)
        .__basher_dag!.getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId, paramPath: 'scale', value: v }],
          'user',
          'p151 pose',
        );
    },
    { nodeId: id, v: value },
  );
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
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder);
  });
});

test('SC-2/SC-6: Apply on a textured imported mesh → three-way verts + material kept', async ({
  page,
}) => {
  await ingest(page, 'p151-child');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  expect(imp.road).toBe('native');
  await waitTextured(page, imp.rootId);
  // A non-identity pose, so Apply has something to move: at identity all three legs read the
  // same whether or not the pose reached the verts.
  await setScale(page, imp.objectId, [2, 1, 1]);
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0])
    .toBeCloseTo(2, 3);
  const before = (await drawnImportMeshes(page, imp.rootId))[0];
  const posedBefore = await posedDataOf(page, imp.objectId);
  // Original world bounds — the THIRD leg of the three-way boundary-pair.
  const origBounds = before.worldBounds;

  const result = await applyTransform(page, imp.objectId);
  expect(result.ok).toBe(true);

  // The Object keeps posing the SAME mesh data, now carrying the pose; nothing was baked.
  await expect
    .poll(async () => (await posedDataOf(page, imp.objectId)).pose.scale)
    .toEqual([1, 1, 1]);
  const posed = await posedDataOf(page, imp.objectId);
  expect(posed.dataId).toBe(imp.dataId);
  expect(posed.dataType).toBe('PolyMeshData');
  expect(posed.mesh).not.toEqual(posedBefore.mesh); // the verts moved…
  expect(posed.material).toEqual(posedBefore.material); // …and the material did not change at all
  expect(await nodeTypes(page)).not.toContain('BakedData');

  // SC-2 — THREE-way verts boundary-pair (H40): drawn == stored model == original world bounds.
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0])
    .toBeCloseTo(origBounds[0], 3);
  const drawn = (await drawnImportMeshes(page, imp.rootId))[0].worldBounds;
  const stored = await storedMeshSize(page, imp.dataId);
  console.log('P151 VERTS three-way =', JSON.stringify({ origBounds, drawn, stored }));
  for (let i = 0; i < 3; i++) {
    expect(drawn[i]).toBeCloseTo(stored[i], 3); // side A == side B
    expect(drawn[i]).toBeCloseTo(origBounds[i], 3); // == the original
  }

  // SC-6 — the drawn material is the one drawn before Apply.
  const after = await waitTextured(page, imp.rootId);
  console.log('P151 MATERIAL after Apply =', JSON.stringify(after));
  expect(after.mapColorSpace).toBe('srgb'); // base map sRGB (M5)
  expect(after.mapWidth).toBe(before.mapWidth);
  expect(after.color).toBe(before.color);
  expect(after.roughness).toBe(before.roughness);
  expect(after.metalness).toBe(before.metalness);
});

test('SC-7 isolation (H45): Apply on one import leaves a second import of the same file unchanged', async ({
  page,
}) => {
  await ingest(page, 'p151-iso-a');
  await ingest(page, 'p151-iso-b');
  await expect.poll(async () => (await importRoots(page)).length).toBe(2);
  const a = await importNamed(page, 0);
  const b = await importNamed(page, 1);
  expect([a.road, b.road]).toEqual(['native', 'native']);
  const bBefore = await waitTextured(page, b.rootId);
  const bPosedBefore = await posedDataOf(page, b.objectId);

  // Give A a non-identity pose, so an Apply that wrote into the shared geometry instance would
  // change what B draws — an identity Apply would leave B's bounds equal either way.
  await setScale(page, a.objectId, [2, 1, 1]);

  const result = await applyTransform(page, a.objectId);
  expect(result.ok).toBe(true);
  await expect
    .poll(async () => (await posedDataOf(page, a.objectId)).pose.scale)
    .toEqual([1, 1, 1]);

  // B's Object and mesh data are untouched in the DAG.
  const bPosedAfter = await posedDataOf(page, b.objectId);
  expect(bPosedAfter).toEqual(bPosedBefore);

  // B still draws at its pre-Apply size (shared geometry not corrupted by A's Apply).
  const bDrawn = await drawnImportMeshes(page, b.rootId);
  expect(bDrawn.length).toBe(1);
  for (let i = 0; i < 3; i++)
    expect(bDrawn[0].worldBounds[i]).toBeCloseTo(bBefore.worldBounds[i], 3);
});

test('SC-5 undo: Apply → Cmd+Z → the original mesh data and pose restored, still textured', async ({
  page,
}) => {
  await ingest(page, 'p151-undo');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  await waitTextured(page, imp.rootId);
  await setScale(page, imp.objectId, [2, 1, 1]);
  const posedBefore = await posedDataOf(page, imp.objectId);
  await applyTransform(page, imp.objectId);
  await expect
    .poll(async () => (await posedDataOf(page, imp.objectId)).pose.scale)
    .toEqual([1, 1, 1]);

  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());

  // The exact packed mesh and pose come back, not merely "a PolyMeshData".
  expect(await posedDataOf(page, imp.objectId)).toEqual(posedBefore);
  expect(await nodeTypes(page)).not.toContain('BakedData');

  // …and it draws textured at the restored pose.
  await waitTextured(page, imp.rootId);
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0])
    .toBeCloseTo(2, 3);
});

test('M8 self-contained: Apply → delete the imported folder → reload → still renders textured', async ({
  page,
}) => {
  await ingest(page, 'p151-selfcontained');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  await waitTextured(page, imp.rootId);
  await setScale(page, imp.objectId, [2, 1, 1]);
  await applyTransform(page, imp.objectId);
  await expect
    .poll(async () => (await posedDataOf(page, imp.objectId)).pose.scale)
    .toEqual([1, 1, 1]);
  const posedApplied = await posedDataOf(page, imp.objectId);

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
  // The applied mesh data is still in the scene: a native import holds nothing that referenced the folder.
  expect(await posedDataOf(page, imp.objectId)).toEqual(posedApplied);

  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });

  // The applied mesh data survives the save + reload byte-for-byte, and still draws textured at
  // the applied size.
  await expect
    .poll(async () => (await posedDataOf(page, imp.objectId)).dataType)
    .toBe('PolyMeshData');
  expect(await posedDataOf(page, imp.objectId)).toEqual(posedApplied);
  await waitTextured(page, imp.rootId);
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0])
    .toBeCloseTo(2, 3);
});

/**
 * The mesh data at the BASE of an Object's data lane, found by the product's own walk — under a
 * modifier the Object's `data` edge names the modifier, not the mesh.
 */
function laneBaseOf(page: Page, objectId: string) {
  return page.evaluate(async (id) => {
    const { resolveDataLaneBase } = await import('/src/app/operatorChain.ts');
    const state = (window as unknown as BasherWindow).__basher_dag!.getState().state;
    const baseId = resolveDataLaneBase(state as never, id);
    const base = state.nodes[baseId];
    return {
      id: baseId,
      type: base?.type ?? null,
      mesh: (base?.params.mesh ?? null) as unknown,
      material: (base?.params.material ?? null) as unknown,
    };
  }, objectId);
}

test('stacked (#1077): Apply under an Array modifier reaches the mesh data, keeps the modifier and the material', async ({
  page,
}) => {
  await ingest(page, 'p151-stacked');
  await expect.poll(async () => (await importRoots(page)).length).toBe(1);
  const imp = await importNamed(page, 0);
  expect(imp.road).toBe('native');
  const plain = await waitTextured(page, imp.rootId);

  // Splice an Array modifier between the mesh data and its Object — the shape "+ Add Modifier"
  // builds. Positive control: the drawn mesh grows, so the stack is live before Apply runs.
  const MOD = 'p151_stacked_array';
  await page.evaluate(
    (ops) =>
      (window as unknown as BasherWindow)
        .__basher_dag!.getState()
        .dispatchAtomic(ops, 'user', 'p151 add array'),
    modifierChainOps({
      objectId: imp.objectId,
      dataId: imp.dataId,
      modifiers: [{ id: MOD, nodeType: 'ArrayModifier', params: { count: 2, offset: [2, 0, 0] } }],
    }),
  );
  await expect
    .poll(async () => (await drawnImportMeshes(page, imp.rootId))[0]?.worldBounds[0] ?? 0)
    .toBeGreaterThan(plain.worldBounds[0] + 0.5);
  await setScale(page, imp.objectId, [2, 1, 1]);
  const baseBefore = await laneBaseOf(page, imp.objectId);
  expect(baseBefore.id).toBe(imp.dataId);
  const drawnBefore = await waitTextured(page, imp.rootId);

  const result = await applyTransform(page, imp.objectId);
  expect(result.ok).toBe(true);
  await expect
    .poll(async () => (await posedDataOf(page, imp.objectId)).pose.scale)
    .toEqual([1, 1, 1]);

  // The Object still wears the modifier, and the modifier still sits on the same mesh data, which
  // now carries the pose and exactly the material it had.
  expect((await posedDataOf(page, imp.objectId)).dataId).toBe(MOD);
  const baseAfter = await laneBaseOf(page, imp.objectId);
  expect(baseAfter.id).toBe(imp.dataId);
  expect(baseAfter.type).toBe('PolyMeshData');
  expect(baseAfter.mesh).not.toEqual(baseBefore.mesh);
  expect(baseAfter.material).toEqual(baseBefore.material);
  expect(await nodeTypes(page)).not.toContain('BakedData');

  // …and it still draws the same textured material.
  const drawnAfter = await waitTextured(page, imp.rootId);
  console.log('P151 STACKED drawn =', JSON.stringify({ drawnBefore, drawnAfter }));
  expect(drawnAfter.color).toBe(drawnBefore.color);
  expect(drawnAfter.roughness).toBe(drawnBefore.roughness);
  expect(drawnAfter.mapWidth).toBe(drawnBefore.mapWidth);
});

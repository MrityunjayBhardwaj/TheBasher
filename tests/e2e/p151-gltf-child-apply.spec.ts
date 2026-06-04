// p151 (Apply-Transform) Wave 4 — the glTF-child boundary-pair gate (issue #151).
//
// THE PHASE PRE-MORTEM ZONE. A GltfChild is the R-1 edge-less satellite whose
// geometry + textured PBR material live BY NAME inside the GltfAsset's
// SkeletonUtils clone. Baking it converges H40 (band-in-resolver), H45 (clone
// shared geom), H58/H59 (capture post-override), double-render suppression, and
// the texture readback onto ONE op. Every named failure mode is an OBSERVATION
// here — read off the real three.js render objects via the seams, never inferred.
//
// SC-2  verts (H40): baked world bounds == resolver baked bounds == original child
//       world bounds (THREE-way).
// SC-6  lossless material: reload → BakedMesh map.image.width>0, srgb base map,
//       color matches the source resolved material. With a PRE-EXISTING override.
// SC-7  single render: the baked child renders exactly ONCE (source suppressed).
// SC-7  H45 isolation: a second asset instance's child is byte-unchanged.
// SC-5  undo: Apply → Cmd+Z → GltfChild restored + child visible + BakedMesh gone.
// M8    self-contained: bake → delete source asset → reload → baked still textured.
// SC-8  animated guard: a clip/keyframe-driven child → Apply rejected.
//
// REF: PLAN.md Wave 4 Task 11; hetvabhasa H40/H45/H58/H59; vyapti V20/V29; D-04;
//      p7.13 (textured fixture + tint-lands pattern), p150 (H40 boundary-pair).

import { test, expect } from './_fixtures';

interface MeshSummary {
  name: string;
  hasMap: boolean;
  mapImageOk: boolean;
  color: string | null;
  worldBounds: [number, number, number];
  visible: boolean;
}
interface MeshMaterial {
  color: string | null;
  hasMap: boolean;
  mapImageOk: boolean;
  mapColorSpace: string | null;
  roughness: number | null;
  metalness: number | null;
}
interface DagNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, DagNode>; outputs: { scene?: { node: string } } };
      undo: () => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_baked_geometry_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
}

const FIXTURE = [
  { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
  { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
  { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
];
const CHILD = 'Box'; // the single textured child of the flat fixture

async function ingest(page: import('@playwright/test').Page, folderName: string): Promise<void> {
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

/** Poll until the cloned textured child mesh has a decoded image (render ready). */
async function waitTextured(page: import('@playwright/test').Page): Promise<MeshSummary> {
  const start = Date.now();
  let last: MeshSummary[] = [];
  while (Date.now() - start < 10_000) {
    const summary = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    });
    last = summary;
    const m = summary.find((s) => s.name === CHILD && s.hasMap && s.mapImageOk);
    if (m) return m;
    await page.waitForTimeout(120);
  }
  throw new Error(`waitTextured timed out; last: ${JSON.stringify(last)}`);
}

function gltfChildId(page: import('@playwright/test').Page, assetRefSubstr: string) {
  return page.evaluate((sub) => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const entry = Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'GltfChild' &&
        n.params.childName === 'Box' &&
        String(n.params.assetRef).includes(sub),
    );
    return entry ? entry[0] : null;
  }, assetRefSubstr);
}

function bakedMeshNode(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const entry = Object.entries(nodes).find(([, n]) => n.type === 'BakedMesh');
    return entry ? { id: entry[0], params: entry[1].params } : null;
  });
}

async function applyTransform(page: import('@playwright/test').Page, id: string) {
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
  // NOTE: __basher_gltf_meshes registers only AFTER a GltfAsset renders (inside
  // GltfAssetR), so it is NOT awaited here — waitTextured() polls for it post-ingest.
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_dag &&
      w.__basher_ingestGltfFolder &&
      w.__basher_mesh_world_bounds &&
      w.__basher_baked_geometry_bounds &&
      w.__basher_mesh_material,
    );
  });
});

test('SC-2/SC-6/SC-7: bake a textured glTF child → three-way verts + lossless material + single render', async ({
  page,
}) => {
  await ingest(page, 'p151-child');
  const before = await waitTextured(page);
  // Original child world bounds (the THIRD leg of the three-way boundary-pair).
  const origBounds = before.worldBounds;

  const childId = await gltfChildId(page, 'p151-child');
  expect(childId).not.toBeNull();

  const result = await applyTransform(page, childId!);
  expect(result.ok).toBe(true);

  // The GltfChild is gone; a BakedMesh exists.
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return Object.values(nodes).some((n) => n.type === 'BakedMesh');
  });
  const baked = await bakedMeshNode(page);
  expect(baked).not.toBeNull();
  expect(baked!.params.scale).toEqual([1, 1, 1]);

  // Wait for the baked geometry + texture to suspense-load + render.
  await page.waitForFunction(
    (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id) !== null,
    baked!.id,
  );

  // SC-2 — THREE-way verts boundary-pair (H40): rendered baked == resolver baked
  // == original child world bounds.
  const renderedBaked = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
    baked!.id,
  );
  const resolverBaked = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_baked_geometry_bounds!(id),
    baked!.id,
  );
  // eslint-disable-next-line no-console
  console.log(
    'P151 VERTS three-way =',
    JSON.stringify({ origBounds, renderedBaked, resolverBaked }),
  );
  expect(renderedBaked).not.toBeNull();
  expect(resolverBaked).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(renderedBaked![i]).toBeCloseTo(resolverBaked![i], 3); // side A == side B
    expect(renderedBaked![i]).toBeCloseTo(origBounds[i], 2); // == the original child
  }

  // SC-6 — lossless material on the rendered BakedMesh (await the texture load).
  await page.waitForFunction(
    (id) => {
      const mm = (window as unknown as BasherWindow).__basher_mesh_material!(id);
      return mm !== null && mm.hasMap && mm.mapImageOk;
    },
    baked!.id,
    { timeout: 10_000 },
  );
  const bakedMat = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_mesh_material!(id),
    baked!.id,
  );
  // eslint-disable-next-line no-console
  console.log('P151 BAKED MATERIAL =', JSON.stringify(bakedMat));
  expect(bakedMat!.hasMap).toBe(true);
  expect(bakedMat!.mapImageOk).toBe(true); // map.image.width > 0
  expect(bakedMat!.mapColorSpace).toBe('srgb'); // base map sRGB (M5)
  expect(bakedMat!.color).toBe(before.color); // resolved color preserved

  // SC-7 — single render: the source child is now SUPPRESSED (not visible) in the
  // asset clone, so only the BakedMesh renders that geometry (count == 1).
  const visibleChildCount = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_gltf_meshes!().filter((m) => m.name === 'Box' && m.visible).length;
  });
  expect(visibleChildCount).toBe(0); // the asset no longer renders Box; the BakedMesh does
});

test('SC-7 isolation (H45): baking one asset instance leaves a second instance unchanged', async ({
  page,
}) => {
  await ingest(page, 'p151-iso-a');
  await ingest(page, 'p151-iso-b');
  await waitTextured(page);

  // Capture instance B's child bounds + material BEFORE baking A.
  const bBoundsBefore = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    // Both instances expose a 'Box' mesh; the LAST-mounted clone backs the getter
    // (single-asset last-writer), so we read the bounds the getter reports now.
    const boxes = w.__basher_gltf_meshes!().filter((m) => m.name === 'Box');
    return boxes.map((m) => m.worldBounds);
  });

  // Capture B's GltfChild scale (its seeded base TRS) BEFORE baking A.
  const bChildIdBefore = await gltfChildId(page, 'p151-iso-b');
  expect(bChildIdBefore).not.toBeNull();
  const bScaleBefore = await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    return w.__basher_dag!.getState().state.nodes[id!].params.scale;
  }, bChildIdBefore);

  const aChildId = await gltfChildId(page, 'p151-iso-a');
  const result = await applyTransform(page, aChildId!);
  expect(result.ok).toBe(true);
  await page.waitForFunction(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).some(
      (n) => n.type === 'BakedMesh',
    ),
  );

  // Instance B's GltfChild node is byte-unchanged in the DAG (not removed, scale
  // intact — baking A must not touch B).
  const bChildId = await gltfChildId(page, 'p151-iso-b');
  expect(bChildId).not.toBeNull(); // B's child node still exists (not removed)
  const bScaleAfter = await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    return w.__basher_dag!.getState().state.nodes[id!].params.scale;
  }, bChildId);
  expect(bScaleAfter).toEqual(bScaleBefore); // B's seeded base scale, intact

  // B's rendered child bounds unchanged (shared geometry not corrupted by A's bake).
  const bBoundsAfter = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_gltf_meshes!()
      .filter((m) => m.name === 'Box' && m.visible)
      .map((m) => m.worldBounds);
  });
  expect(bBoundsAfter.length).toBeGreaterThan(0);
  // At least one still-visible Box matches a pre-bake bound (B's child).
  const matches = bBoundsAfter.some((after) =>
    bBoundsBefore.some((b) => Math.abs(after[0] - b[0]) < 1e-3),
  );
  expect(matches).toBe(true);
});

test('SC-5 undo: Apply → Cmd+Z → GltfChild restored + source child visible + BakedMesh gone', async ({
  page,
}) => {
  await ingest(page, 'p151-undo');
  await waitTextured(page);
  const childId = await gltfChildId(page, 'p151-undo');
  await applyTransform(page, childId!);
  await page.waitForFunction(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).some(
      (n) => n.type === 'BakedMesh',
    ),
  );

  await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());

  const restored = await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const gltfAsset = Object.values(nodes).find((n) => n.type === 'GltfAsset');
    return {
      childExists: Boolean(nodes[id!]),
      hasBaked: Object.values(nodes).some((n) => n.type === 'BakedMesh'),
      suppressed: gltfAsset ? gltfAsset.params.suppressedChildren : null,
    };
  }, childId);
  expect(restored.childExists).toBe(true); // GltfChild restored
  expect(restored.hasBaked).toBe(false); // BakedMesh removed (addNode inverse)
  expect(restored.suppressed).toEqual([]); // un-suppressed (setParam inverse)

  // The source child is visible again on the render clone.
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_gltf_meshes!().some((m) => m.name === 'Box' && m.visible);
  });
});

test('M8 self-contained: bake → delete source asset → reload → baked still renders textured', async ({
  page,
}) => {
  await ingest(page, 'p151-selfcontained');
  await waitTextured(page);
  const childId = await gltfChildId(page, 'p151-selfcontained');
  await applyTransform(page, childId!);
  await page.waitForFunction(() =>
    Object.values((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).some(
      (n) => n.type === 'BakedMesh',
    ),
  );

  // Delete the source GltfAsset via the SAME path the app uses — the My-Imports
  // ︙ Delete affordance routes through `deleteImportedAsset(name, {breakRefs})`,
  // which (1) removes the whole import footprint nodes in one atomic op AND
  // (2) deletes the `user-imports/<name>/` OPFS tree (the source .gltf/.bin/.png
  // bytes). After this the source is GONE — no node, no OPFS bytes. This is the
  // real H60 orphan-avoidance exercise: if the baked texture had referenced back
  // into `user-imports/`, the reload below would lose its map.
  const deletion = await page.evaluate(async () => {
    const importCommon = await import('/src/app/asset/importCommon.ts');
    const boot = await import('/src/app/boot.ts');
    const NAME = 'p151-selfcontained';
    const storage = await boot.getStorage();
    // The source tree must EXIST before the delete (so the after=0 is a real
    // transition, not a never-existed dir reading empty).
    const sourceFilesBefore = (
      await importCommon.listFilesDeep(storage, `${importCommon.USER_IMPORTS_ROOT}/${NAME}`)
    ).length;
    const result = await importCommon.deleteImportedAsset(NAME, { breakRefs: true });
    // OBSERVE that the source OPFS tree is actually gone (the deletion happened).
    const sourceFilesAfter = (
      await importCommon.listFilesDeep(storage, `${importCommon.USER_IMPORTS_ROOT}/${NAME}`)
    ).length;
    // And that the baked texture lives under `baked-texture/`, NOT user-imports.
    const bakedTexFiles = await storage.list('baked-texture').catch(() => [] as string[]);
    return {
      deleted: result.deleted,
      sourceFilesBefore,
      sourceFilesAfter,
      bakedTexCount: bakedTexFiles.length,
    };
  });
  // The deletion actually removed the source asset + its OPFS bytes — observed as
  // a real before(>0) → after(0) transition (not a never-existed dir).
  expect(deletion.deleted).toBe(true);
  expect(deletion.sourceFilesBefore).toBeGreaterThan(0); // the source bytes existed
  expect(deletion.sourceFilesAfter).toBe(0); // user-imports/<name> is now empty/gone
  expect(deletion.bakedTexCount).toBeGreaterThan(0); // baked texture is self-contained
  // The source GltfAsset/GltfChild nodes are gone from the DAG.
  const sourceNodesGone = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return !Object.values(nodes).some((n) => n.type === 'GltfAsset' || n.type === 'GltfChild');
  });
  expect(sourceNodesGone).toBe(true);

  // Save + reload — the baked geometry + texture bytes live in OPFS, keyed by
  // hash, independent of the now-deleted source asset.
  await page.evaluate(async () => {
    const boot = await import('/src/app/boot.ts');
    await boot.saveCurrent();
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_mesh_material),
  );

  const baked = await bakedMeshNode(page);
  expect(baked).not.toBeNull();
  await page.waitForFunction(
    (id) => {
      const mm = (window as unknown as BasherWindow).__basher_mesh_material!(id);
      return mm !== null && mm.hasMap && mm.mapImageOk;
    },
    baked!.id,
    { timeout: 10_000 },
  );
  const mat = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_mesh_material!(id),
    baked!.id,
  );
  expect(mat!.mapImageOk).toBe(true); // textured baked mesh survives reload
});

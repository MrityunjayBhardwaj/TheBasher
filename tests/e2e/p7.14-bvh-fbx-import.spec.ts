// P7.14 Wave A — BVH/FBX disk-import Lokayata gate (closes #111).
//
// The end-to-end OBSERVATION that the BVH/FBX ingestion SURFACE works on real
// disk bytes. The importers (buildBvhImportOps / buildFbxImportOps) already
// existed and were proven by their own unit tests; #111 added only the
// surface — read OPFS bytes a drop/picker wrote, decode per-format, dispatch.
// We drive the full write → ingest → dispatchAtomic path through the new dev
// seams `__basher_ingestBvhFile` / `__basher_ingestFbxFile` (boot.ts), the
// same single-file chokepoint the drop/picker chains funnel through.
//
// THE load-bearing assertion (grounded): BVH/FBX are MOTION, not models. They
// emit a `Skeleton` + an `AnimationClip` node — NEVER a Mesh or GltfAsset.
// We assert on the DAG node-type delta (the producer side) plus OPFS layout
// plus the My-Imports list (the consumer surfaces). A mesh appearing would be
// the regression this gate catches.
//
// Fixtures (committed, fetched at runtime — H41 "exercise the NEW path"):
//   public/fixtures/anim/walk.bvh  — 2-bone BVH, 2 frames (text).
//   public/fixtures/anim/rig.fbx   — minimal ASCII FBX, 2-bone skeleton + a
//                                    1s translation curve (binary decode path).
//
// REF: PLAN 7.14 Wave A (A4); CONTEXT D-02/D-05; issue #111;
//      src/app/boot.ts (the __basher_ingestBvh/FbxFile seams);
//      src/app/asset/importBvhFbx.ts (importBvh/FbxFromOpfs + dispatcher);
//      src/app/AssetsPopover.tsx (the library-popover-my-imports list).

import { test, expect } from './_fixtures';

interface DagNode {
  type: string;
  params?: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, DagNode> } };
  };
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
  __basher_ingestFbxFile?: (bytes: Uint8Array, name: string) => Promise<string>;
}

/** Fetch a fixture's bytes page-side and feed them to the single-file ingest
 *  seam. Mirrors p7.9's ingestFixtures — bytes never cross the Playwright
 *  bridge. */
async function ingestMotionFixture(
  page: import('@playwright/test').Page,
  seam: 'bvh' | 'fbx',
  urlPath: string,
  name: string,
): Promise<string> {
  return page.evaluate(
    async ({ kind, url, n }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const bytes = new Uint8Array(buf);
      return kind === 'bvh'
        ? await w.__basher_ingestBvhFile!(bytes, n)
        : await w.__basher_ingestFbxFile!(bytes, n);
    },
    { kind: seam, url: urlPath, n: name },
  );
}

/** Snapshot the count of nodes of a given type in the live DAG. */
async function nodeTypeCount(page: import('@playwright/test').Page, type: string): Promise<number> {
  return page.evaluate((t) => {
    const w = window as unknown as BasherWindow;
    return Object.values(w.__basher_dag.getState().state.nodes).filter((n) => n.type === t).length;
  }, type);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_ingestBvhFile && w.__basher_ingestFbxFile);
  });
});

test('P7.14 (a) — BVH ingest yields Skeleton + AnimationClip (motion, not mesh) + OPFS + My Imports', async ({
  page,
}) => {
  const skelBefore = await nodeTypeCount(page, 'Skeleton');
  const clipBefore = await nodeTypeCount(page, 'AnimationClip');
  const meshBefore = await nodeTypeCount(page, 'Mesh');

  const entryPath = await ingestMotionFixture(page, 'bvh', '/fixtures/anim/walk.bvh', 'walk');
  expect(entryPath).toBe('user-imports/walk/walk.bvh');

  // DAG: a Skeleton + AnimationClip landed; NO mesh (grounded: motion, not model).
  await expect.poll(async () => await nodeTypeCount(page, 'Skeleton')).toBe(skelBefore + 1);
  await expect.poll(async () => await nodeTypeCount(page, 'AnimationClip')).toBe(clipBefore + 1);
  expect(await nodeTypeCount(page, 'Mesh')).toBe(meshBefore);
  expect(await nodeTypeCount(page, 'GltfAsset')).toBe(0);

  // OPFS: the single file landed at user-imports/walk/walk.bvh.
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const walk = await userImports.getDirectoryHandle('walk');
    const names: string[] = [];
    for await (const e of (
      walk as unknown as { values: () => AsyncIterable<{ name: string }> }
    ).values()) {
      names.push(e.name);
    }
    return names;
  });
  expect(opfs).toEqual(['walk.bvh']);

  // My Imports: the entry shows in the popover.
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('library-popover')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/walk/walk.bvh'),
  ).toBeVisible({ timeout: 5_000 });
});

test('P7.14 (b) — FBX ingest yields Skeleton + AnimationClip (binary decode) + OPFS', async ({
  page,
}) => {
  const skelBefore = await nodeTypeCount(page, 'Skeleton');
  const clipBefore = await nodeTypeCount(page, 'AnimationClip');
  const meshBefore = await nodeTypeCount(page, 'Mesh');

  const entryPath = await ingestMotionFixture(page, 'fbx', '/fixtures/anim/rig.fbx', 'rig');
  expect(entryPath).toBe('user-imports/rig/rig.fbx');

  await expect.poll(async () => await nodeTypeCount(page, 'Skeleton')).toBe(skelBefore + 1);
  await expect.poll(async () => await nodeTypeCount(page, 'AnimationClip')).toBe(clipBefore + 1);
  expect(await nodeTypeCount(page, 'Mesh')).toBe(meshBefore);
  expect(await nodeTypeCount(page, 'GltfAsset')).toBe(0);

  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const rig = await userImports.getDirectoryHandle('rig');
    const names: string[] = [];
    for await (const e of (
      rig as unknown as { values: () => AsyncIterable<{ name: string }> }
    ).values()) {
      names.push(e.name);
    }
    return names;
  });
  expect(opfs).toEqual(['rig.fbx']);
});

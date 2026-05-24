// P7.6 — glTF skinned-animation deformation (closes #88).
//
// The bug: a skinned glTF dropped today animates its joint scene-nodes
// (#81's TransformClip path moves them by name) but the MESH stays in T-pose,
// because GltfAssetR cloned with Object3D.clone — which leaves the cloned
// SkinnedMesh bound to the ORIGINAL bones (the three.js skinned-clone footgun).
// The fix is SkeletonUtils.clone (SceneFromDAG.tsx GltfAssetR).
//
// Two gates, in order:
//   B2 (Lokāyata validity): the fixture builds a BOUND SkinnedMesh — proven via
//       the DEV seam window.__basher_gltf_skin() over the rendered cloned mesh.
//       If this fails, the fixture is malformed and B3 would be meaningless.
//   B3 (headline / D-02): a skin-bound VERTEX world-position moves between
//       t=0 and t=mid — observing DEFORMATION, not joint TRS (the joints move
//       today regardless of the fix; only the bound vertex moving proves the
//       skin follows). Driven by REAL render time via __basher_time.setTime
//       (the p7.3-gizmo pattern — NOT p7.5's __basher_evaluate, which hits the
//       pure evaluator with no mounted GltfAssetR / no render frame).
//
// Staging: the renderer loads bytes from OPFS (useResolvedAssetUrl), so we both
// write the fixture bytes to OPFS (__basher_writeOpfsBytes) AND import its
// structure (__basher_importGltf) under the SAME assetRef — the GltfAsset then
// renders the SkinnedMesh (OPFS bytes) and animates it (TransformClip from the
// imported animation). The fixture + tip vertex index come from
// scripts/gen-skinned-fixture.mjs (TIP_VERTEX_INDEX = 4, weighted to Bone1).
//
// REF: PLAN.md Wave B; CONTEXT 7.6 D-02; src/viewport/SceneFromDAG.tsx (clone +
// __basher_gltf_skin seam); dharana B12 (glTF loader boundary observation).

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/skinned-bar.glb';
const FIXTURE_URL = '/assets/skinned-bar.glb';
const TIP_VERTEX = 4; // far-end vertex weighted to Bone1 (gen-skinned-fixture.mjs)

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: { getState: () => { state: { outputs: { scene?: { node: string } } } } };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
  ) => Promise<{ gltfAssetId: string; transformClipIds: string[] }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
}

/** Stage the fixture: bytes → OPFS, structure → DAG, then wait for the
 *  rendered SkinnedMesh seam to register. Returns nothing; throws on timeout. */
async function stageSkinnedBar(page: import('@playwright/test').Page) {
  // Fetch the committed fixture (served from public/) into the page, write it
  // to OPFS at the assetRef the importer will reference, then import.
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  // Wait for GltfAssetR to mount, suspend-resolve useGLTF from OPFS, clone, and
  // register the DEV observation seam over the rendered SkinnedMesh.
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );
}

/** Drive REAL render time and let the mounted scene repaint (2 rAFs) so the
 *  bone-matrix palette recomputes before the next read (p7.3 model). */
async function setRenderTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    const w = window as unknown as BasherWindow;
    w.__basher_time!.getState().setTime(s);
  }, seconds);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Fresh OPFS so the writeOpfsBytes staging is the only source of the asset.
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_time);
  });
});

test('P7.6 B2 — the fixture renders a bound SkinnedMesh (validity gate)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await stageSkinnedBar(page);

  const handle = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const s = w.__basher_gltf_skin!();
    return s ? { boneCount: s.boneCount, bound: s.bound } : null;
  });
  expect(handle).not.toBeNull();
  expect(handle!.boneCount).toBeGreaterThanOrEqual(2);
  expect(handle!.bound).toBe(true);

  // B12 — no GLTFLoader/THREE/skeleton errors during load.
  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

test('P7.6 B3 — a skin-bound vertex deforms between t=0 and t=mid (D-02 headline)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await stageSkinnedBar(page);

  // t=0: bind pose (Bone1 identity). Record the tip vertex world position.
  await setRenderTime(page, 0);
  const p0 = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );

  // t=mid: Bone1 rotated (the 'bend' clip runs 0→~85° over t∈[0,1]).
  await setRenderTime(page, 0.9);
  const pMid = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );

  // The deformed surface point MOVED. This is the #88 acceptance: joints move
  // (true today) AND the skin follows (the SkeletonUtils.clone fix). Asserted
  // on the VERTEX, never the bone TRS — reverting the clone fix makes this fail
  // while B2 still passes (the test catches the footgun, not the joint TRS).
  const delta = Math.hypot(pMid[0] - p0[0], pMid[1] - p0[1], pMid[2] - p0[2]);
  expect(delta, `tip vertex barely moved (delta=${delta}); skin did not deform`).toBeGreaterThan(
    0.2,
  );

  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

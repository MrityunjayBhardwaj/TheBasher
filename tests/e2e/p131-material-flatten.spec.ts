// #131 (D-05) — the coarse flatten / clay toggle `ignoreSourceMaterial`.
//
// SCOPE: a SEPARATE primitive from the #124 per-field `overridden` set. The
// per-field set FORCES one channel while keeping the clone + every other map
// (a flatten of one scalar, not a drop). `ignoreSourceMaterial` is the honest
// wholesale-replace: the renderer ignores the source material entirely and
// builds a fresh one from the 7 scalars — the source's maps + subclass are
// dropped BY INTENT (the opt-in version of the old #99 wholesale-replace bug).
//
// THE PROOF (Lokayata — observe the rendered three.js material, not the node
// params; H40/H59 boundary-pair):
//   (0) Import a TEXTURED METAL glTF (baseColorTexture → .map;
//       metallicRoughnessTexture → .metalnessMap + .roughnessMap).
//   (1) Baseline: the rendered mesh reports hasMap + hasMetalnessMap.
//   (2) Override WITHOUT flatten (#99 + #124 clone path) → every map survives
//       (the clone preserves them). Falsification anchor for step 3.
//   (3) Flatten on (ignoreSourceMaterial:true) → the source maps are GONE by
//       intent (hasMap===false, hasMetalnessMap===false), the scalars land
//       (metalness reads the override's value), the material renders as clay.
//   (4) Flatten off → the clone path restores every map (the toggle is the
//       only lever; nothing in #99/#124 is undone).
//
// Observation seam: SceneFromDAG `__basher_gltf_meshes()` (DEV-only, read-only,
// V8 clean) — exposes each mesh's live map presence + scalar channels.

import { test, expect } from './_fixtures';

interface MeshSummary {
  readonly name: string;
  readonly hasMap: boolean;
  readonly mapImageOk: boolean;
  readonly color: string | null;
  readonly metalness: number | null;
  readonly roughness: number | null;
  readonly hasMetalnessMap: boolean;
  readonly hasRoughnessMap: boolean;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params?: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

interface FixtureSpec {
  readonly urlPath: string;
  readonly relativePath: string;
}

async function ingestFixtures(
  page: import('@playwright/test').Page,
  fixtures: ReadonlyArray<FixtureSpec>,
  folderName: string,
): Promise<string> {
  return page.evaluate(
    async ({ fixtures: f, name }) => {
      const w = window as unknown as BasherWindow;
      const files: IngestFileShape[] = [];
      for (const spec of f) {
        const buf = await fetch(spec.urlPath).then((r) => r.arrayBuffer());
        files.push({ relativePath: spec.relativePath, bytes: new Uint8Array(buf) });
      }
      return await w.__basher_ingestGltfFolder!(files, name);
    },
    { fixtures: fixtures as FixtureSpec[], name: folderName },
  );
}

/** Poll the rendered mesh summary until a mesh satisfies `accept`. */
async function pollForMesh(
  page: import('@playwright/test').Page,
  accept: (m: MeshSummary) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<MeshSummary> {
  const start = Date.now();
  let last: MeshSummary[] = [];
  while (Date.now() - start < timeoutMs) {
    const summary = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    });
    last = summary;
    const match = summary.find((m) => accept(m));
    if (match) return match;
    await page.waitForTimeout(120);
  }
  throw new Error(`pollForMesh(${label}) timed out; last summary: ${JSON.stringify(last)}`);
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
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder);
  });
});

/** Wire a MaterialOverride between the imported GltfAsset and its Group (V67). */
async function applyOverride(
  page: import('@playwright/test').Page,
  params: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((p) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes;
    const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset');
    // V67: import root is a transformable Group (was a Transform); the asset
    // wires into Group.children (a list socket, was Transform.target/single).
    const groupId = Object.keys(nodes).find((id) => nodes[id].type === 'Group');
    if (!gltfId || !groupId) throw new Error('expected GltfAsset + Group from import');
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: gltfId, socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
        { type: 'addNode', nodeId: 'mo131', nodeType: 'MaterialOverride', params: p },
        {
          type: 'connect',
          from: { node: gltfId, socket: 'out' },
          to: { node: 'mo131', socket: 'target' },
        },
        {
          type: 'connect',
          from: { node: 'mo131', socket: 'out' },
          to: { node: groupId, socket: 'children' },
        },
      ],
      'user',
      '#131 apply material override',
    );
  }, params);
}

async function setFlatten(page: import('@playwright/test').Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: 'mo131', paramPath: 'ignoreSourceMaterial', value }],
      'user',
      `#131 flatten=${value}`,
    );
  }, on);
}

test('#131 (D-05) — ignoreSourceMaterial drops source maps by intent; off restores them', async ({
  page,
}) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // (0) Import the textured METAL fixture (baseColorTexture + metallicRoughnessTexture).
  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/metal/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/metal/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/metal/texture.png', relativePath: 'texture.png' },
    ],
    'flatten-asset',
  );
  expect(entryPath).toBe('user-imports/flatten-asset/scene.gltf');

  // (1) Baseline: textured + metal, carrying base/metalness/roughness maps.
  const baseline = await pollForMesh(page, (m) => m.hasMap && m.mapImageOk, 'baseline');
  expect(
    baseline.hasMetalnessMap,
    `metal fixture must carry maps; ${JSON.stringify(baseline)}`,
  ).toBe(true);
  expect(baseline.hasRoughnessMap).toBe(true);

  // (2) Override WITHOUT flatten (#99 + #124 clone path) → every map survives.
  //     This is the falsification anchor: if flatten fired unconditionally the
  //     maps would already be gone here.
  await applyOverride(page, { color: '#3399ff', roughness: 0.2, metalness: 0.1 });
  const cloned = await pollForMesh(page, (m) => m.color === '#3399ff', 'clone-path');
  expect(
    cloned.hasMap && cloned.hasMetalnessMap && cloned.hasRoughnessMap,
    `the clone path must preserve all source maps; ${JSON.stringify(cloned)}`,
  ).toBe(true);

  // (3) THE CAPABILITY — flatten on → the source maps are GONE by intent and the
  //     fresh clay material reports the override's scalars.
  await setFlatten(page, true);
  const flattened = await pollForMesh(page, (m) => !m.hasMap, 'flattened');
  expect(flattened.hasMap, 'flatten drops the base color map by intent').toBe(false);
  expect(flattened.hasMetalnessMap, 'flatten drops the metalnessMap by intent').toBe(false);
  expect(flattened.hasRoughnessMap, 'flatten drops the roughnessMap by intent').toBe(false);
  expect(flattened.metalness, 'the clay material reports the override metalness').toBe(0.1);
  expect(flattened.roughness, 'the clay material reports the override roughness').toBe(0.2);

  // (4) Flatten off → the clone path restores every map (the toggle is the only
  //     lever; #99/#124 behaviour is untouched).
  await setFlatten(page, false);
  const restored = await pollForMesh(page, (m) => m.hasMap, 'restored');
  expect(
    restored.hasMap && restored.hasMetalnessMap && restored.hasRoughnessMap,
    `turning flatten off must restore the clone path's maps; ${JSON.stringify(restored)}`,
  ).toBe(true);

  expect(loaderErrors, `unexpected loader console errors: ${loaderErrors.join('\n')}`).toEqual([]);
});

// P7.9 Wave F Task 12 — glTF file-import Lokayata gate (closes #110).
//
// This is the end-to-end OBSERVATION that the Wave A–E ingest pipeline
// works on real disk-shaped multi-file inputs. The five upstream surfaces
// (drop, picker, My Imports refresh, multi-file sibling resolution, the
// percent-encoding fix from Task 11) compose into a single user-visible
// behaviour: "drop a folder, see it rendered with its texture, see it in
// My Imports without re-opening the popover, and have it survive reload".
//
// We drive the full write → ingest → dispatchAtomic → render path through
// the new dev seam `window.__basher_ingestGltfFolder` (boot.ts:290), which
// is the same seam the picker/drop chains funnel through. Fixtures are the
// three committed multi-file bundles under `public/fixtures/multifile/`
// (flat, nested, spaced) plus the bundled single-file `cube-draco.glb`
// (Draco-compressed, already proven loadable by p0-gltf-draco). No
// synthetic-in-memory GLB shortcut — H41 says fixtures must exercise the
// NEW path from day one so a future regression surfaces here, not at user
// merge.
//
// Six sub-cases:
//   (a)  FLAT multi-file → textured Mesh in scene + OPFS flat at root.
//   (a2) NESTED-entry (../buffers/, ../textures/) → textured Mesh +
//        OPFS preserves the gltf|buffers|textures/ nesting (C1 sibling-
//        path trap).
//   (a3) SPACED filename (`my texture.png` on disk; `my%20texture.png` in
//        the JSON URI) → textured Mesh + zero loader error (this is the
//        Task 11 percent-encoding fix's deferred rendered-surface gate).
//   (b)  My Imports freshness — entry appears in an ALREADY-OPEN popover
//        WITHOUT a re-open, survives a page reload, and re-imports via
//        drag (C3 non-optional freshness guarantee).
//   (c)  Single `.glb` layout = `user-imports/<basename>/<basename>.glb`
//        (C5 — same layout for drop, picker, and ingest).
//   (d)  No-glTF folder → error banner + zero dispatch + scene unchanged.
//
// Boundary-pair observation (H40 — "which side did I observe?"): we
// observe on the RENDERER side (the cloned Mesh tree's material.map via
// the `__basher_gltf_meshes` DEV seam) plus OPFS (storage.list /
// storage.exists) plus the Library popover DOM. The producer side
// (importGltfFromOpfs / ingestGltfFolder return values) is asserted only
// where it adds incremental signal (the entry-path layout claim). The Op
// log is consulted only for sub-case (d)'s "no dispatch" negative.
//
// REF: PLAN.md Wave F Task 12; CONTEXT 7.9 D-01..D-05; issue #110;
//      `src/app/boot.ts:283-297` (the new ingest seam);
//      `src/app/asset/importGltf.ts` (ingestGltfFolder + importGltfFromOpfs);
//      `src/viewport/SceneFromDAG.tsx` GltfAssetR (the
//      `__basher_gltf_meshes` DEV seam added for this gate);
//      `src/app/AssetsPopover.tsx` (the `library-popover-my-imports` list).

import { test, expect } from './_fixtures';

interface MeshSummary {
  readonly name: string;
  readonly hasMap: boolean;
  readonly mapImageOk: boolean;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params?: Record<string, unknown> }>;
        outputs: { scene?: { node: string } };
      };
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

/** Ingest a set of fixtures end-to-end inside the page. Bytes never leave
 *  the browser context — the spec hands URLs + relativePaths in, the
 *  page-side code fetches the bytes and feeds them straight to
 *  `__basher_ingestGltfFolder`. This avoids Playwright JSON-serialising
 *  binary data across the bridge (each round-trip is OK in principle but
 *  is also unnecessary friction). */
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

/** Poll for a Mesh whose material has a non-null map AND a loaded image
 *  (decoded width > 0). useGLTF is suspense-driven + the image decode is
 *  async; the mesh summary is empty until GltfAssetR mounts and the
 *  texture image finishes decoding. Returns the matched summary entries. */
async function pollForTexturedMesh(
  page: import('@playwright/test').Page,
  timeoutMs = 8_000,
): Promise<MeshSummary[]> {
  const start = Date.now();
  let last: MeshSummary[] = [];
  while (Date.now() - start < timeoutMs) {
    const summary = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    });
    last = summary;
    if (summary.some((m) => m.hasMap && m.mapImageOk)) return summary;
    await page.waitForTimeout(120);
  }
  throw new Error(`pollForTexturedMesh timed out; last mesh summary: ${JSON.stringify(last)}`);
}

/** Wipe OPFS so each test starts from a clean ledger (mirror p7.6's
 *  beforeEach pattern — OPFS persists per-origin across test cases). */
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

test('P7.9 (a) — FLAT multi-file ingest renders textured + OPFS flat at root', async ({ page }) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
    ],
    'flat-asset',
  );

  expect(entryPath).toBe('user-imports/flat-asset/scene.gltf');

  // OPFS layout: flat at root, no nesting.
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const flatAsset = await userImports.getDirectoryHandle('flat-asset');
    const names: string[] = [];
    for await (const entry of (
      flatAsset as unknown as { values: () => AsyncIterable<{ name: string }> }
    ).values()) {
      names.push(entry.name);
    }
    return names.sort();
  });
  expect(opfs).toEqual(['scene.bin', 'scene.gltf', 'texture.png']);

  // Rendered surface: a textured Mesh exists.
  const summary = await pollForTexturedMesh(page);
  expect(
    summary.some((m) => m.hasMap && m.mapImageOk),
    `expected at least one textured mesh; got ${JSON.stringify(summary)}`,
  ).toBe(true);

  expect(loaderErrors, `unexpected loader console errors: ${loaderErrors.join('\n')}`).toEqual([]);
});

test('P7.9 (a2) — NESTED-entry ingest preserves nesting + renders textured (C1 trap)', async ({
  page,
}) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // The nested fixture's entry sits at `gltf/scene.gltf` and references
  // `../buffers/scene.bin` + `../textures/texture.png`. We preserve the
  // in-folder relativePath verbatim (same as the picker / webkitdirectory
  // path), so the importer writes under `user-imports/nested-asset/gltf/`,
  // `user-imports/nested-asset/buffers/`, etc., and the sentinel resolver
  // resolves `../foo.bin` against `gltf/`'s directory correctly.
  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/nested/gltf/scene.gltf', relativePath: 'gltf/scene.gltf' },
      {
        urlPath: '/fixtures/multifile/nested/buffers/scene.bin',
        relativePath: 'buffers/scene.bin',
      },
      {
        urlPath: '/fixtures/multifile/nested/textures/texture.png',
        relativePath: 'textures/texture.png',
      },
    ],
    'nested-asset',
  );

  // The entry is nested, not root.
  expect(entryPath).toBe('user-imports/nested-asset/gltf/scene.gltf');

  // OPFS layout: nesting preserved verbatim.
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const nestedAsset = await userImports.getDirectoryHandle('nested-asset');
    const layout: Record<string, string[]> = {};
    for await (const sub of (
      nestedAsset as unknown as { values: () => AsyncIterable<{ name: string; kind: string }> }
    ).values()) {
      if (sub.kind !== 'directory') continue;
      const dir = await nestedAsset.getDirectoryHandle(sub.name);
      const inner: string[] = [];
      for await (const entry of (
        dir as unknown as { values: () => AsyncIterable<{ name: string }> }
      ).values()) {
        inner.push(entry.name);
      }
      layout[sub.name] = inner.sort();
    }
    return layout;
  });
  expect(Object.keys(opfs).sort()).toEqual(['buffers', 'gltf', 'textures']);
  expect(opfs.gltf).toEqual(['scene.gltf']);
  expect(opfs.buffers).toEqual(['scene.bin']);
  expect(opfs.textures).toEqual(['texture.png']);

  // Rendered surface: sibling resolver fired through `../`-relative paths
  // and the textured Mesh is present.
  const summary = await pollForTexturedMesh(page);
  expect(
    summary.some((m) => m.hasMap && m.mapImageOk),
    `expected at least one textured mesh from nested fixture; got ${JSON.stringify(summary)}`,
  ).toBe(true);

  expect(
    loaderErrors,
    `unexpected loader console errors in nested case: ${loaderErrors.join('\n')}`,
  ).toEqual([]);
});

test('P7.9 (a3) — SPACED-filename ingest renders textured (Task 11 fix gate)', async ({ page }) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // The on-disk filename has a LITERAL SPACE; the dev-server URL encodes
  // the space. The glTF JSON's images[0].uri is `my%20texture.png` (per
  // the spec §3.9.3.1). The on-disk OPFS relativePath we ingest is the
  // DECODED form — `my texture.png` — exactly what a real drop /
  // webkitdirectory picker would surface. Task 11's percent-encoding fix
  // makes the renderer decode the URI when looking up the sibling.
  const entryPath = await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/spaced/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/spaced/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/spaced/my%20texture.png', relativePath: 'my texture.png' },
    ],
    'spaced-asset',
  );

  expect(entryPath).toBe('user-imports/spaced-asset/scene.gltf');

  // OPFS layout: the literal-space filename made it to disk.
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const spaced = await userImports.getDirectoryHandle('spaced-asset');
    const names: string[] = [];
    for await (const entry of (
      spaced as unknown as { values: () => AsyncIterable<{ name: string }> }
    ).values()) {
      names.push(entry.name);
    }
    return names.sort();
  });
  expect(opfs).toEqual(['my texture.png', 'scene.bin', 'scene.gltf']);

  // Rendered surface: the percent-encoded URI in the JSON resolved
  // through Task 11's decodeURIComponent path and the texture loaded.
  const summary = await pollForTexturedMesh(page);
  expect(
    summary.some((m) => m.hasMap && m.mapImageOk),
    `expected textured mesh from spaced fixture; got ${JSON.stringify(summary)}`,
  ).toBe(true);

  expect(
    loaderErrors,
    `unexpected loader console errors in spaced case: ${loaderErrors.join('\n')}`,
  ).toEqual([]);
});

test('P7.9 (b) — My Imports refresh: entry appears in an already-open popover + survives reload', async ({
  page,
}) => {
  // 1. Open the popover BEFORE the ingest. The freshness contract (C3 +
  //    AssetsPopover.tsx:122-182) says the `[open, tick]` effect re-runs
  //    on every bump from importGltfFromOpfs — so the entry must appear
  //    without a manual close/reopen.
  // The popover trigger lives in TopToolbar; click it to anchor + open.
  // (data-testid mirrors `top-toolbar-assets` in TopToolbar.tsx:111.)
  const trigger = page.getByTestId('top-toolbar-assets');
  await trigger.click();
  const popover = page.getByTestId('library-popover');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  // No My-Imports section yet (fresh OPFS state, only sample assets).
  await expect(page.getByTestId('library-popover-my-imports')).toHaveCount(0);

  // 2. Ingest WITHOUT touching the popover.
  await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
    ],
    'freshness-asset',
  );

  // 3. With the popover still open, the My-Imports section appears with
  //    `freshness-asset` — driven by importRefreshStore.tick bumping after
  //    dispatchAtomic returned.
  await expect(page.getByTestId('library-popover-my-imports')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/freshness-asset/scene.gltf'),
  ).toBeVisible({ timeout: 5_000 });

  // 4. Reload — persistence proof (OPFS is the source of truth, V18 — no
  //    localStorage mirror).
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder);
  });
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('library-popover')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/freshness-asset/scene.gltf'),
  ).toBeVisible({ timeout: 5_000 });
});

test('P7.9 (c) — single .glb layout = user-imports/<basename>/<basename>.glb (C5)', async ({
  page,
}) => {
  const loaderErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/GLTFLoader|DRACOLoader|parse glTF|Failed to load/i.test(t)) loaderErrors.push(t);
  });
  page.on('pageerror', (e) => loaderErrors.push(e.message));

  // The bundled cube-draco.glb is a single-file glTF (Draco-compressed)
  // already proven loadable by p0-gltf-draco. Importing it via the ingest
  // seam exercises the single-file branch of `ingestGltfFolder` —
  // `locateEntryFile` picks the only `.glb` at depth 0 and writes one
  // file under `user-imports/<basename>/`.
  const entryPath = await ingestFixtures(
    page,
    [{ urlPath: '/assets/cube-draco.glb', relativePath: 'cube-draco.glb' }],
    'cube-draco',
  );

  expect(entryPath).toBe('user-imports/cube-draco/cube-draco.glb');

  // OPFS layout: exactly one file at the canonical path (C5 parity).
  const opfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const basher = await root.getDirectoryHandle('basher');
    const userImports = await basher.getDirectoryHandle('user-imports');
    const dir = await userImports.getDirectoryHandle('cube-draco');
    const names: string[] = [];
    for await (const entry of (
      dir as unknown as { values: () => AsyncIterable<{ name: string }> }
    ).values()) {
      names.push(entry.name);
    }
    return names;
  });
  expect(opfs).toEqual(['cube-draco.glb']);

  // Scene contains a GltfAsset child with the user-imports assetRef.
  // (cube-draco may or may not carry a texture — we don't assert hasMap
  // here; the loader's success is asserted by the GltfAsset DAG child
  // landing in the scene AND zero loader console errors below.)
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = window as unknown as BasherWindow;
          const state = w.__basher_dag.getState().state;
          return Object.values(state.nodes).filter(
            (n) =>
              n.type === 'GltfAsset' &&
              (n.params as { assetRef?: string } | undefined)?.assetRef ===
                'user-imports/cube-draco/cube-draco.glb',
          ).length;
        }),
      { timeout: 5_000 },
    )
    .toBeGreaterThan(0);

  expect(
    loaderErrors,
    `unexpected loader console errors in single-glb case: ${loaderErrors.join('\n')}`,
  ).toEqual([]);
});

test('P7.9 (d) — folder with no glTF surfaces the error banner + no Op dispatched', async ({
  page,
}) => {
  // Snapshot the GltfAsset-node count BEFORE the failed ingest so we can
  // assert no addNode landed (the "no Op dispatched" claim).
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const state = w.__basher_dag.getState().state;
    return Object.values(state.nodes).filter((n) => n.type === 'GltfAsset').length;
  });

  const result = await page.evaluate(
    async ({ name }) => {
      const w = window as unknown as BasherWindow;
      // A single non-glTF file. ingestGltfFolder's locateEntryFile returns
      // null → reports to assetErrorStore → re-throws.
      const files = [{ relativePath: 'README.md', bytes: new Uint8Array([1, 2, 3]) }];
      try {
        await w.__basher_ingestGltfFolder!(files, name);
        return { threw: false, message: null as string | null };
      } catch (e) {
        return { threw: true, message: e instanceof Error ? e.message : String(e) };
      }
    },
    { name: 'empty-asset' },
  );

  expect(result.threw).toBe(true);
  expect(result.message).toMatch(/no glTF/i);

  // Error banner visible with the matching row.
  await expect(page.getByTestId('asset-error-banner')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('asset-error-row-empty-asset')).toBeVisible({ timeout: 5_000 });

  // No new GltfAsset Op landed.
  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const state = w.__basher_dag.getState().state;
    return Object.values(state.nodes).filter((n) => n.type === 'GltfAsset').length;
  });
  expect(after).toBe(before);
});

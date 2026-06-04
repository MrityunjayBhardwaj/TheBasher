// P151 Wave 3 Task 7 — LOKAYATA PROBE: which texture-readback path is available
// on a SkeletonUtils-cloned glTF child material? (issue #151)
//
// WHY this exists (RESEARCH §M4): baking a textured glTF child losslessly wants
// to copy the ORIGINAL compressed bytes (path 1) rather than re-encode via a
// canvas (path 2). Path 1 requires a Texture→sourceURI association to survive the
// `SkeletonUtils.clone` GltfAssetR performs. Whether it survives is a
// MEDIUM-confidence runtime question — so we OBSERVE it here rather than infer it
// from reading three.js source. The bake (Wave 4) ships path 2 unconditionally
// and uses path 1 ONLY if this probe confirms a usable association.
//
// THE OBSERVATION: import the textured flat fixture (scene.gltf + scene.bin +
// texture.png) through the real ingest pipeline, then read the extended
// `__basher_gltf_meshes().mapProbe` seam on the cloned, rendered child material.
// Assert the canvas-readback prerequisite (image.width>0) holds — that gate is
// what makes path 2 universal — and RECORD which path-1 association surfaced.

import { test, expect } from './_fixtures';

interface MapProbe {
  imageWidth: number;
  imageHeight: number;
  hasUserDataSrcUri: boolean;
  hasSourceData: boolean;
  sourceDataUri: string | null;
  imageSrc: string | null;
}
interface MeshSummary {
  name: string;
  hasMap: boolean;
  mapImageOk: boolean;
  mapProbe: MapProbe | null;
}
interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag?: unknown;
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

async function pollForTexturedMesh(
  page: import('@playwright/test').Page,
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
    const match = summary.find((m) => m.hasMap && m.mapImageOk);
    if (match) return match;
    await page.waitForTimeout(120);
  }
  throw new Error(`pollForTexturedMesh timed out; last summary: ${JSON.stringify(last)}`);
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

test('P151 PROBE — texture-readback path available on the cloned glTF child material', async ({
  page,
}) => {
  await ingestFixtures(
    page,
    [
      { urlPath: '/fixtures/multifile/flat/scene.gltf', relativePath: 'scene.gltf' },
      { urlPath: '/fixtures/multifile/flat/scene.bin', relativePath: 'scene.bin' },
      { urlPath: '/fixtures/multifile/flat/texture.png', relativePath: 'texture.png' },
    ],
    'probe-asset',
  );

  const mesh = await pollForTexturedMesh(page);
  const probe = mesh.mapProbe;
  expect(probe).not.toBeNull();
  if (!probe) throw new Error('mapProbe missing');

  // OBSERVE — print the full probe so the executor can RECORD the path in the
  // commit body (the whole point of t7).
  // eslint-disable-next-line no-console
  console.log('P151 TEXTURE-READBACK PROBE =', JSON.stringify({ name: mesh.name, ...probe }));

  // PATH (2) prerequisite — the canvas readback needs a decoded image with real
  // dimensions. This is the UNIVERSAL path, asserted to hold so the wave cannot
  // block on the path-(1) outcome.
  expect(probe.imageWidth).toBeGreaterThan(0);
  expect(probe.imageHeight).toBeGreaterThan(0);

  // PATH (1) — at least ONE source-association surface should be present for the
  // lossless optimization to be usable. three 0.169 keeps the decoded image on
  // `texture.source.data`, so `hasSourceData` is the expected survivor. We assert
  // the disjunction (not a specific field) so the test records the available
  // path without over-fitting to one association mechanism.
  const path1Available =
    probe.hasUserDataSrcUri ||
    probe.hasSourceData ||
    probe.sourceDataUri !== null ||
    probe.imageSrc !== null;
  expect(path1Available).toBe(true);
});

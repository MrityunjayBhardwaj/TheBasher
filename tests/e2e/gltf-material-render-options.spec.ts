// #217 — imported glTF materials are fully tweakable in the inspector like a
// native base object: the Render Options (double-sided / alpha cutout) and the
// Texture Placement (UV tiling) controls now exist in the glTF material editor
// and drive the rendered clone live.
//
// THE PROOF (falsifiable, boundary-pair): import a glTF child → select it →
// toggle a render option / edit a UV field IN THE INSPECTOR → assert BOTH the
// DAG material (side A) AND the rendered three.js clone (side B, via
// __basher_gltf_meshes — the same live seam the renderer's overlay feeds) change.
// Pre-#217 these controls did not exist, so the clone's side/alphaTest/mapRepeat
// could never change from the inspector.

import { test, expect } from './_fixtures';

const FRONT_SIDE = 0;
const DOUBLE_SIDE = 2; // THREE.FrontSide / THREE.DoubleSide

interface MeshSummary {
  name: string;
  side: number | null;
  alphaTest: number | null;
  mapRepeat: [number, number] | null;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => MeshSummary[];
}

async function ingest(page: import('@playwright/test').Page, file: string, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(
    async ([f, name]) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${f}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder([{ relativePath: f, bytes }], name);
    },
    [file, folder] as const,
  );
}

/** The first GltfChild that captured materials, + its active-slot geometry/uv/name. */
function materialChild(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && Array.isArray(n.params.materials),
    );
    if (!c) return null;
    const m0 = (c.params.materials as Record<string, unknown>[])[0];
    return { id: c.id, geometry: m0.geometry, uvTransform: m0.uvTransform, name: m0.name };
  });
}

const firstMesh = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [])[0] ?? null;
  });

async function selectAndOpen(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((nid) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(nid);
  }, id);
  await page.getByTestId('inspector-section-toggle-material').click();
  await expect(page.getByTestId(`inspector-gltf-material-editor-${id}`)).toBeVisible();
}

test.describe('#217 — glTF material render-options + UV inspector controls', () => {
  test('toggling double-sided in the inspector flips the rendered side', async ({ page }) => {
    await ingest(page, 'cube-draco.glb', 'ro-ds');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!.id);

    // Pre-edit the clone is front-only.
    await expect.poll(async () => (await firstMesh(page))?.side).toBe(FRONT_SIDE);

    await page.getByTestId(`inspector-doublesided-${child!.id}-0`).check();

    // Side A — DAG material flag set; Side B — the clone renders double-sided.
    await expect
      .poll(async () => {
        const g = (await materialChild(page))?.geometry as { doubleSided?: boolean } | undefined;
        return g?.doubleSided;
      })
      .toBe(true);
    await expect.poll(async () => (await firstMesh(page))?.side).toBe(DOUBLE_SIDE);
  });

  test('setting alpha cutout in the inspector drives the rendered alphaTest', async ({ page }) => {
    await ingest(page, 'cube-draco.glb', 'ro-ac');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!.id);

    await expect.poll(async () => (await firstMesh(page))?.alphaTest).toBe(0); // off by default

    const input = page.getByTestId(`inspector-alphacutoff-${child!.id}-0`);
    await input.fill('0.5');
    await input.blur();

    await expect
      .poll(async () => {
        const g = (await materialChild(page))?.geometry as { alphaCutoff?: number } | undefined;
        return g?.alphaCutoff;
      })
      .toBe(0.5);
    await expect.poll(async () => (await firstMesh(page))?.alphaTest).toBe(0.5);
  });

  // #220 — the imported material name is a label (not appearance), so the proof is
  // the DAG side (side A) + the read-side: the field resyncs to the committed name.
  test('renaming a material in the inspector updates the DAG name', async ({ page }) => {
    await ingest(page, 'cube-draco.glb', 'ro-name');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!.id);

    const input = page.getByTestId(`inspector-gltfmat-name-${child!.id}-0`);
    await expect(input).toBeVisible();
    await input.fill('brushed steel');
    await input.blur();

    // Side A — the DAG material carries the new name.
    await expect.poll(async () => (await materialChild(page))?.name).toBe('brushed steel');
    // Read-side — the input reflects the committed name (resync from the DAG).
    await expect(input).toHaveValue('brushed steel');
  });

  test('editing UV tiling in the inspector re-tiles the rendered map', async ({ page }) => {
    // uv-transform-quad is textured (mapRepeat readable) and captures uvTransform.
    await ingest(page, 'uv-transform-quad.gltf', 'ro-uv');
    await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
    const child = await materialChild(page);
    await selectAndOpen(page, child!.id);

    // The Texture Placement section now renders for glTF (was native-only).
    const tilingX = page.getByTestId(`inspector-uvtransform-tilingX-${child!.id}-0`);
    await expect(tilingX).toBeVisible();
    await tilingX.fill('4');
    await tilingX.blur();

    await expect
      .poll(async () => {
        const uv = (await materialChild(page))?.uvTransform as
          | { tiling: [number, number] }
          | undefined;
        return uv?.tiling?.[0];
      })
      .toBe(4);
    await expect.poll(async () => (await firstMesh(page))?.mapRepeat?.[0]).toBe(4);
  });
});

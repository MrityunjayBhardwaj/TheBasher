// #1062 — a native import's second UV set and its colour are still drawn after Apply, save and
// reload.
//
// ── WHY BOTH STEPS, ON THE DRAWN SIDE ─────────────────────────────────────────────────
//
// Each half has a unit gate: Apply's transform carries named corner layers
// (`dispatchApplyTransform.test.ts`) and a packed mesh round-trips its layers (#1117). Neither
// can say the pieces still meet on screen afterwards: that the material still NAMES its layer,
// that the reloaded mesh still CARRIES a layer by that name, and that the draw resolves one to
// the other. A save that dropped a layer name, or an Apply that rebuilt the material without
// it, passes both unit gates and draws a grey quad. So this reads the drawn three.js mesh after
// the whole road, for both subjects, and the captured material beside it.
//
// ── WHAT IS READ, AND WHY NOT PIXELS HERE ─────────────────────────────────────────────
//
// The drawn side is the live geometry's buffer names and the live material: `color` in the
// buffers with `vertexColors` on, and `uv1` in the buffers with the base map sampling channel
// 1. The UV set's pixels are read by `p997-replaced-map-uv-set`; the colour's were observed by
// hand when the draw landed and no spec reads them yet. This file's question is survival, and a
// value that survives with the wrong buffer behind it is caught by the pair read together.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`transformMeshData`), src/nodes/PolyMeshData.ts,
//      src/app/cornerLayerNames.ts, tests/e2e/_importedMesh.ts; issues #1062, #1117.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { drawnImportMeshes, importedMeshes } from './_importedMesh';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_ingestGltfFolder &&
        w.__basher_opfs,
      );
    },
    { timeout: 20_000 },
  );
}

async function openFresh(page: Page): Promise<void> {
  await page.goto('/');
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
  await waitForEditor(page);
}

async function ingest(page: Page, file: string, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder!([{ relativePath: file, bytes }], folder);
    },
    { file, folder },
  );
}

type Material = {
  geometry?: { colorLayer?: string };
  mapUvLayers?: { albedo?: string };
};

/** Each native import, keyed by root, with what it captured and what it draws. */
async function subjects(page: Page) {
  const meshes = await importedMeshes(page);
  const drawn = await drawnImportMeshes(page);
  return meshes.map((m) => {
    const material = (m.slots[0] ?? {}) as Material;
    const d = drawn.find((x) => x.rootId === m.rootId) ?? null;
    return {
      road: m.road,
      rootId: m.rootId,
      objectId: m.objectId,
      colorLayer: material.geometry?.colorLayer ?? null,
      albedoUvLayer: material.mapUvLayers?.albedo ?? null,
      drawn: d && {
        buffers: d.buffers,
        vertexColors: d.vertexColors,
        mapChannel: d.mapChannel,
        mapImageOk: d.mapImageOk,
      },
    };
  });
}

/** The colour subject and the two-UV subject, told apart by what each captured. */
async function pair(page: Page) {
  const all = await subjects(page);
  return {
    count: all.length,
    colour: all.find((s) => s.colorLayer !== null) ?? null,
    twoUv: all.find((s) => s.albedoUvLayer !== null) ?? null,
  };
}

/** Both subjects drawn with their layers: the state this file asserts at every step. */
async function expectBothDrawn(page: Page, step: string): Promise<void> {
  await expect
    .poll(async () => {
      const p = await pair(page);
      return {
        count: p.count,
        colour: p.colour && {
          road: p.colour.road,
          colorLayer: p.colour.colorLayer,
          vertexColors: p.colour.drawn?.vertexColors ?? null,
          hasColourBuffer: p.colour.drawn?.buffers.includes('color') ?? null,
        },
        twoUv: p.twoUv && {
          road: p.twoUv.road,
          albedoUvLayer: p.twoUv.albedoUvLayer,
          mapChannel: p.twoUv.drawn?.mapChannel ?? null,
          hasUv1Buffer: p.twoUv.drawn?.buffers.includes('uv1') ?? null,
          mapImageOk: p.twoUv.drawn?.mapImageOk ?? null,
        },
      };
    }, step)
    .toEqual({
      count: 2,
      colour: { road: 'native', colorLayer: 'Color', vertexColors: true, hasColourBuffer: true },
      twoUv: {
        road: 'native',
        albedoUvLayer: 'UVMap.001',
        mapChannel: 1,
        hasUv1Buffer: true,
        mapImageOk: true,
      },
    });
}

test('#1062 — a second UV set and a colour survive Apply, save and reload, on screen', async ({
  page,
}) => {
  test.slow(); // two imports, two Applies, a save and a reload, each observed
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFresh(page);

  await ingest(page, 'vertex-color-quad.gltf', 'p1062-colour');
  await ingest(page, 'two-uv-quad.gltf', 'p1062-two-uv');
  await expectBothDrawn(page, 'after import');

  // Apply a transform that is NOT identity, with a mirror, so Apply rewrites the mesh and
  // reverses its corner order — the path that moves every layer's values.
  const { colour, twoUv } = await pair(page);
  for (const objectId of [colour!.objectId, twoUv!.objectId]) {
    const result = await page.evaluate(async (id) => {
      type Dag = {
        getState: () => {
          state: {
            nodes: Record<
              string,
              { params: Record<string, unknown>; inputs: Record<string, unknown> }
            >;
          };
          dispatchAtomic: (ops: unknown[], s: string, l: string) => void;
        };
      };
      const dag = (window as unknown as { __basher_dag: Dag }).__basher_dag;
      const meshOf = () => {
        const { nodes } = dag.getState().state;
        const dataId = (nodes[id].inputs.data as { node: string }).node;
        return JSON.stringify(nodes[dataId].params.mesh);
      };
      const before = meshOf();
      dag.getState().dispatchAtomic(
        [
          { type: 'setParam', nodeId: id, paramPath: 'rotation', value: [0, 0.4, 0] },
          { type: 'setParam', nodeId: id, paramPath: 'scale', value: [-1.5, 1, 1] },
        ],
        'e2e',
        '#1062 pose before Apply',
      );
      const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
      const applied = (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean };
      return {
        ok: applied.ok,
        meshRewritten: meshOf() !== before,
        scale: dag.getState().state.nodes[id].params.scale,
      };
    }, objectId);
    // Apply took the stored-mesh road: the mesh was rewritten and the pose returned to identity.
    expect(result, `Apply on ${objectId}`).toEqual({
      ok: true,
      meshRewritten: true,
      scale: [1, 1, 1],
    });
  }
  await expectBothDrawn(page, 'after Apply');

  // Save, and wait until the project file on disk names both layers.
  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId, 'the editor has a current project to save into').not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as BasherWindow;
          if (!(await w.__basher_opfs!.exists(path))) return false;
          const text = new TextDecoder().decode(await w.__basher_opfs!.read(path));
          return text.includes('UVMap.001') && text.includes('"colorLayer"');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.reload();
  await waitForEditor(page);
  await expectBothDrawn(page, 'after reload');

  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

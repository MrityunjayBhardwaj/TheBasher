// #1327 — a glTF material's clearcoat textures come across a native import, draw, survive a save
// and a bake, and the coat normal's strength can be edited in the inspector.
//
// Before this, the native reader refused any file with a texture inside `KHR_materials_clearcoat`
// ("a texture the native material does not hold"). The fixture carries all three coat textures, each
// a different image WIDTH (2, 4, 8), so a slot that drew another slot's image reads the wrong width;
// and a coat normal at scale 0.5.
//
// Read on the drawn three material, never on the DAG: a map stored and never assigned would pass
// every DAG read. The coat normal's y is negative for the reason the base normal's is (#1325): an
// unflipped glTF upload on a mesh without tangents, which three's loader corrects the same way for
// both (`GLTFLoader.js:3468-3469`). The bake case takes its expected reading from the clone BEFORE
// the bake, which three's own loader drew.
//
// REF: src/nodes/types.ts (`MATERIAL_MAP_SLOT_TABLE`, the coat rows);
//      src/core/import/gltfJsonMaterialToOpenpbr.ts (`IR_SLOT_SOURCES`, `captureMapStrengths`);
//      src/app/materialRegistry.ts (`build`); src/viewport/SceneFromDAG.tsx (`CapturedBakedMeshR`);
//      src/app/NPanel.tsx (the strength rows); issue #1327.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';
import { ingestOnCloneRoad } from './_cloneRoadImport';

const FIXTURE = 'clearcoat-quad.gltf';

interface Coat {
  clearcoat: number | null;
  clearcoatMapWidth: number | null;
  clearcoatRoughnessMapWidth: number | null;
  clearcoatNormalMapWidth: number | null;
  clearcoatNormalScale: [number, number] | null;
}

interface Win {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
        >;
      };
    };
  };
  __basher_selection: { getState: () => { select: (id: string | null) => void } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_mesh_material: (nodeId: string) => (Coat & Record<string, unknown>) | null;
  __basher_three: unknown;
}

/** What the file says, as three's loader draws it on a mesh without tangents. */
const FROM_FILE: Coat = {
  clearcoat: 1,
  clearcoatMapWidth: 2,
  clearcoatRoughnessMapWidth: 4,
  clearcoatNormalMapWidth: 8,
  clearcoatNormalScale: [0.5, -0.5],
};

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_mesh_material && w.__basher_three);
  });
}

async function ingest(page: Page, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as Win).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file: FIXTURE, folder },
  );
}

/** The imported Object and the stored mesh it draws. */
async function imported(page: Page): Promise<{ objectId: string; dataId: string }> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).filter(
            (n) => n.type === 'PolyMeshData',
          ).length,
      ),
    )
    .toBe(1);
  return page.evaluate(() => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    const dataId = Object.entries(nodes).find(([, n]) => n.type === 'PolyMeshData')![0];
    const objectId = Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === dataId,
    )![0];
    return { objectId, dataId };
  });
}

const storedStrengths = (page: Page, dataId: string) =>
  page.evaluate(
    (id) =>
      (
        (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.material as {
          mapStrengths?: unknown;
        }
      ).mapStrengths ?? null,
    dataId,
  );

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id): Coat | null => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return (
      m && {
        clearcoat: m.clearcoat,
        clearcoatMapWidth: m.clearcoatMapWidth,
        clearcoatRoughnessMapWidth: m.clearcoatRoughnessMapWidth,
        clearcoatNormalMapWidth: m.clearcoatNormalMapWidth,
        clearcoatNormalScale: m.clearcoatNormalScale,
      }
    );
  }, objectId);

async function saveAndReload(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = '/src/app/boot.ts';
    const boot = (await import(/* @vite-ignore */ url)) as { saveCurrent: () => Promise<void> };
    await boot.saveCurrent();
  });
  await page.reload();
  await ready(page);
}

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
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
  await ready(page);
});

test('#1327 — a file’s clearcoat textures import native, draw, and survive a save', async ({
  page,
}) => {
  await ingest(page, 'p1327-native');
  const { objectId, dataId } = await imported(page);
  expect(await storedStrengths(page, dataId)).toEqual({ coatNormal: 0.5 });
  await expect.poll(() => drawn(page, objectId)).toEqual(FROM_FILE);

  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});

test('#1327 — the inspector edits the clearcoat normal’s strength', async ({ page }) => {
  await ingest(page, 'p1327-edit');
  const { objectId, dataId } = await imported(page);
  await expect.poll(() => drawn(page, objectId)).toEqual(FROM_FILE);

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const input = page.locator(
    '[data-testid$=".mapStrengths.coatNormal"][data-testid^="inspector-input-"]',
  );
  await expect(input).toHaveCount(1);
  await expect(input).toHaveValue('0.5');
  // The base normal's row belongs to a base normal map, and this file has none.
  await expect(page.locator('[data-testid$=".mapStrengths.normal"]')).toHaveCount(0);

  await input.fill('0.25');
  await input.press('Enter');
  await expect.poll(() => storedStrengths(page, dataId)).toEqual({ coatNormal: 0.25 });
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ ...FROM_FILE, clearcoatNormalScale: [0.25, -0.25] });
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: a clone-road import baked by Apply keeps the coat maps and the coat
// normal's strength, and the rebuild draws them as three's loader drew the clone.
test('#1327 — a bake keeps the clearcoat textures and draws them as the loader did', async ({
  page,
}) => {
  await ingestOnCloneRoad(page, FIXTURE, 'p1327-bake');
  // Before the bake the clone draws through three's own loader: the reference reading.
  await expect.poll(() => visibleCoated(page)).toEqual({ ...FROM_FILE, count: 1 });
  const applied = await page.evaluate(async () => {
    const nodes = (window as unknown as Win).__basher_dag.getState().state.nodes;
    const dataId = Object.entries(nodes).find(([, n]) => n.type === 'GltfData')?.[0];
    const objectId = Object.entries(nodes).find(
      ([, n]) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === dataId,
    )?.[0];
    const url = '/src/app/animate/dispatchApplyTransform.ts';
    const mod = (await import(/* @vite-ignore */ url)) as {
      dispatchApplyTransform: (id: string | undefined, what: 'all') => Promise<{ ok: boolean }>;
    };
    return (await mod.dispatchApplyTransform(objectId, 'all')).ok;
  });
  expect(applied).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values((window as unknown as Win).__basher_dag.getState().state.nodes).filter(
            (n) => n.type === 'BakedData',
          ).length,
      ),
    )
    .toBe(1);
  await expect.poll(() => visibleCoated(page)).toEqual({ ...FROM_FILE, count: 1 });
  expect(errors).toEqual([]);
});

/** The one VISIBLE coat-mapped mesh's coat; Apply leaves the clone mounted and hidden. */
function visibleCoated(page: Page) {
  return page.evaluate(() => {
    type Tex = { image?: { width?: number } } | null | undefined;
    const three = (
      window as unknown as {
        __basher_three: {
          getState: () => {
            scene: {
              traverseVisible: (
                cb: (o: {
                  isMesh?: boolean;
                  material?: {
                    clearcoat?: number;
                    clearcoatMap?: Tex;
                    clearcoatRoughnessMap?: Tex;
                    clearcoatNormalMap?: Tex;
                    clearcoatNormalScale?: { x: number; y: number };
                  };
                }) => void,
              ) => void;
            } | null;
          };
        };
      }
    ).__basher_three.getState();
    const width = (t: Tex) => (t ? (t.image?.width ?? 0) : null);
    const found: Record<string, unknown>[] = [];
    three.scene?.traverseVisible((o) => {
      const m = o.material;
      if (o.isMesh && m?.clearcoatMap?.image) {
        found.push({
          clearcoat: m.clearcoat ?? null,
          clearcoatMapWidth: width(m.clearcoatMap),
          clearcoatRoughnessMapWidth: width(m.clearcoatRoughnessMap),
          clearcoatNormalMapWidth: width(m.clearcoatNormalMap),
          clearcoatNormalScale: m.clearcoatNormalMap
            ? [m.clearcoatNormalScale!.x, m.clearcoatNormalScale!.y]
            : null,
        });
      }
    });
    return { ...(found[0] ?? {}), count: found.length };
  });
}

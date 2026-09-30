// #1329 — a glTF material's sheen textures come across a native import, draw, survive a save and
// a bake: the first map slots not seeded that hold a COLOUR, so the drawn colour space is read too.
//
// Before this, the native reader refused a file with a texture inside `KHR_materials_sheen` ("a
// texture the native material does not hold"; #1123 held the sheen's factors only, as the fuzz
// lobe). The fixture has a sheen colour texture 8 px wide and a sheen roughness texture 16 px
// wide, so each drawn map is identified by its image. three's loader reads the colour as sRGB
// (`GLTFLoader.js:1017`) and the roughness as data (`:1023`); the glTF extension says the same
// (`KHR_materials_sheen.md`, sheenColorTexture "in sRGB transfer function").
//
// Read on the drawn three material, never on the DAG. The bake case takes its expected reading from
// the clone BEFORE the bake, which three's own loader drew.
//
// REF: src/nodes/types.ts (`MATERIAL_MAP_SLOT_TABLE`, the fuzzColor / fuzzRoughness rows);
//      src/core/import/gltfJsonMaterialToOpenpbr.ts (`IR_SLOT_SOURCES`); issue #1329.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { ingestOnCloneRoad } from './_cloneRoadImport';

const FIXTURE = 'sheen-texture-quad.gltf';

interface Sheen {
  sheen: number | null;
  sheenRoughness: number | null;
  sheenColorMapWidth: number | null;
  sheenColorMapTransfer: string | null;
  sheenRoughnessMapWidth: number | null;
  sheenRoughnessMapTransfer: string | null;
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
  __basher_mesh_material: (nodeId: string) => (Sheen & Record<string, unknown>) | null;
  __basher_three: unknown;
}

/**
 * What the file says, as three's loader draws it. A map's colour space is read as the TRANSFER
 * three decodes it with, because that is what draws: three's loader leaves the roughness map at
 * `NoColorSpace` ('', `GLTFLoader.js:1023` passes none), our table stamps 'srgb-linear', and three
 * decodes both as linear (`ColorManagement.js:124`) into the same texture format
 * (`WebGLTextures.js:204`). Only sRGB changes the draw.
 */
const FROM_FILE: Sheen = {
  sheen: 1,
  sheenRoughness: 0.5,
  sheenColorMapWidth: 8,
  sheenColorMapTransfer: 'srgb',
  sheenRoughnessMapWidth: 16,
  sheenRoughnessMapTransfer: 'linear',
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

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id): Sheen | null => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    const transferOf = (cs: unknown) => (cs == null ? null : cs === 'srgb' ? 'srgb' : 'linear');
    return (
      m && {
        sheen: m.sheen,
        sheenRoughness: m.sheenRoughness,
        sheenColorMapWidth: m.sheenColorMapWidth,
        sheenColorMapTransfer: transferOf(m.sheenColorMapColorSpace),
        sheenRoughnessMapWidth: m.sheenRoughnessMapWidth,
        sheenRoughnessMapTransfer: transferOf(m.sheenRoughnessMapColorSpace),
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

test('#1329 — a file’s sheen textures import native, draw, and survive a save', async ({
  page,
}) => {
  await ingest(page, 'p1329-native');
  const { objectId } = await imported(page);
  await expect.poll(() => drawn(page, objectId)).toEqual(FROM_FILE);

  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(FROM_FILE);
  expect(errors).toEqual([]);
});

// The baked mesh's own builder: a clone-road import baked by Apply keeps both sheen maps, and
// the rebuild draws it as three's loader drew the clone.
test('#1329 — a bake keeps the sheen textures and draws them as the loader did', async ({
  page,
}) => {
  await ingestOnCloneRoad(page, FIXTURE, 'p1329-bake');
  const FROM_LOADER = { ...FROM_FILE, count: 1 };
  await expect.poll(() => visibleSheen(page)).toEqual(FROM_LOADER);
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
  await expect.poll(() => visibleSheen(page)).toEqual(FROM_LOADER);
  expect(errors).toEqual([]);
});

/** The one VISIBLE sheen-mapped mesh; Apply leaves the clone mounted and hidden. */
function visibleSheen(page: Page) {
  return page.evaluate(() => {
    type Tex = { image?: { width?: number }; colorSpace?: string } | null | undefined;
    const three = (
      window as unknown as {
        __basher_three: {
          getState: () => {
            scene: {
              traverseVisible: (
                cb: (o: {
                  isMesh?: boolean;
                  material?: {
                    sheen?: number;
                    sheenRoughness?: number;
                    sheenColorMap?: Tex;
                    sheenRoughnessMap?: Tex;
                  };
                }) => void,
              ) => void;
            } | null;
          };
        };
      }
    ).__basher_three.getState();
    const transferOf = (cs: unknown) => (cs == null ? null : cs === 'srgb' ? 'srgb' : 'linear');
    const found: Record<string, unknown>[] = [];
    three.scene?.traverseVisible((o) => {
      const m = o.material;
      if (o.isMesh && m?.sheenColorMap?.image) {
        found.push({
          sheen: m.sheen ?? null,
          sheenRoughness: m.sheenRoughness ?? null,
          sheenColorMapWidth: m.sheenColorMap.image.width ?? 0,
          sheenColorMapTransfer: transferOf(m.sheenColorMap.colorSpace),
          sheenRoughnessMapWidth: m.sheenRoughnessMap?.image?.width ?? null,
          sheenRoughnessMapTransfer: transferOf(m.sheenRoughnessMap?.colorSpace),
        });
      }
    });
    return { ...(found[0] ?? {}), count: found.length };
  });
}

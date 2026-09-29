// #1123 — a glTF sheen imports native as OpenPBR's fuzz lobe, draws as three's sheen, survives a
// save, can be created in the inspector on a material that has none, and survives a bake.
//
// Before this the native reader refused `KHR_materials_sheen`. Both references take it at weight
// 1 with the file's colour and roughness (Blender's Sheen Weight 1, three's `sheen = 1`), and so does
// the native material. `sheen-quad.gltf` says colour [1,1,1] (linear: white) and roughness 0.3.
//
// Read on the drawn three material, not the DAG. The inspector case is the plan's open question for
// a new optional lobe: an edit on a lobe that is absent has to create the whole lobe, its other
// fields at OpenPBR's defaults (colour white, roughness 0.5).
//
// REF: src/nodes/types.ts (`fuzz`); src/core/import/gltfJsonMaterialToOpenpbr.ts (the sheen read);
//      src/app/materialRegistry.ts (`build`); src/app/NPanel.tsx (the Fuzz row);
//      src/viewport/SceneFromDAG.tsx (`CapturedBakedMeshR`); issue #1123.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { openInspectorSection } from './_inspectorSections';
import { ingestOnCloneRoad } from './_cloneRoadImport';

interface DrawnMaterial {
  sheen: number | null;
  sheenColor: string | null;
  sheenRoughness: number | null;
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
  __basher_mesh_material: (nodeId: string) => DrawnMaterial | null;
  __basher_three: unknown;
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<Win>;
    return Boolean(w.__basher_ingestGltfFolder && w.__basher_mesh_material && w.__basher_three);
  });
}

async function ingest(page: Page, file: string, folder: string): Promise<void> {
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as Win).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
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

const stored = (page: Page, dataId: string) =>
  page.evaluate(
    (id) =>
      (
        (window as unknown as Win).__basher_dag.getState().state.nodes[id].params.material as {
          fuzz?: unknown;
        }
      ).fuzz ?? null,
    dataId,
  );

const drawn = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const m = (window as unknown as Win).__basher_mesh_material(id);
    return m && { sheen: m.sheen, sheenColor: m.sheenColor, sheenRoughness: m.sheenRoughness };
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

const IMPORTED = { sheen: 1, sheenColor: '#ffffff', sheenRoughness: 0.3 };

test('#1123 — a sheen material imports native, draws its sheen, and survives a save', async ({
  page,
}) => {
  await ingest(page, 'sheen-quad.gltf', 'p1123-sheen');
  const { objectId, dataId } = await imported(page);
  expect(await stored(page, dataId)).toEqual({ weight: 1, color: '#ffffff', roughness: 0.3 });
  await expect.poll(() => drawn(page, objectId)).toEqual(IMPORTED);
  await saveAndReload(page);
  const after = await imported(page);
  await expect.poll(() => drawn(page, after.objectId)).toEqual(IMPORTED);
  expect(errors).toEqual([]);
});

test('#1123 — the inspector creates a fuzz lobe on a material that has none', async ({ page }) => {
  await ingest(page, 'normal-map-quad.gltf', 'p1123-fuzz-edit');
  const { objectId, dataId } = await imported(page);
  // The control: no lobe stored, and three's default (no sheen) drawn.
  expect(await stored(page, dataId)).toBeNull();
  await expect.poll(async () => (await drawn(page, objectId))?.sheen).toBe(0);

  await page.evaluate(
    (id) => (window as unknown as Win).__basher_selection.getState().select(id),
    objectId,
  );
  await openInspectorSection(page, 'material');
  const weight = page.locator('[data-testid^="inspector-input-"][data-testid$=".fuzz.weight"]');
  await expect(weight).toHaveCount(1);
  await expect(weight).toHaveValue('0');
  await weight.fill('0.6');
  await weight.press('Enter');
  await expect
    .poll(() => stored(page, dataId))
    .toEqual({ weight: 0.6, color: '#ffffff', roughness: 0.5 });
  await expect
    .poll(() => drawn(page, objectId))
    .toEqual({ sheen: 0.6, sheenColor: '#ffffff', sheenRoughness: 0.5 });
  expect(errors).toEqual([]);
});

test('#1123 — a bake keeps the sheen colour and roughness', async ({ page }) => {
  // One UV set: the baked store refuses a second one (#1130), which `sheen-quad.gltf` carries.
  await ingestOnCloneRoad(page, 'sheen-one-uv-quad.gltf', 'p1123-sheen-bake');
  const read = () =>
    page.evaluate(() => {
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
                      sheenColor?: { getHexString: () => string };
                      sheenRoughness?: number;
                    };
                  }) => void,
                ) => void;
              } | null;
            };
          };
        }
      ).__basher_three.getState();
      const found: { sheen: number; sheenColor: string; sheenRoughness: number }[] = [];
      three.scene?.traverseVisible((o) => {
        const m = o.material;
        if (o.isMesh && m && typeof m.sheen === 'number' && m.sheen > 0) {
          found.push({
            sheen: m.sheen,
            sheenColor: `#${m.sheenColor!.getHexString()}`,
            sheenRoughness: m.sheenRoughness!,
          });
        }
      });
      return { ...(found[0] ?? {}), count: found.length };
    });
  // Before the bake the clone draws through three's own loader: the reference reading.
  await expect.poll(read).toEqual({ ...IMPORTED, count: 1 });
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
  await expect.poll(read).toEqual({ ...IMPORTED, count: 1 });
  expect(errors).toEqual([]);
});

// p1139 — Apply on a textured primitive keeps its texture and where it sits, through save and reload.
//
// Before #1139 the primitive bake wrote six null maps and a frozen look: a box drawing a texture at
// tiling [2,2] baked into an untextured box, and Apply said ok. The texture here is a real project
// image — the one a native import of `albedo-textured-quad.gltf` stores — given to a split box as its
// material, the way the inspector's material copy would. Each read is off the live three.js
// texture of the box's own scene object, whose id the bake inherits.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`bakedSpecFromInline`),
//      src/viewport/SceneFromDAG.tsx (`BakedMeshR`); issues #1139, #1136.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeDataId, splitCubeOps } from './_splitCube';
import { firstMaterialMesh } from './_importedMesh';

interface W {
  __basher_dag?: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string; params: Record<string, unknown> }>;
      };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    folderName: string,
  ) => Promise<string>;
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

const BOX = 'n_p1139_box';
// three's `Matrix3.setUvTransform` for tiling [2,2] about the centre (column-major): the
// translation is -2·0.5 + 0.5 = -0.5 on each axis.
const PLACED_UV_MATRIX = [2, 0, 0, 0, 2, 0, -0.5, -0.5, 1];

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
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

/** The box's drawn base-colour texture: its UV matrix and whether its image decoded, or null. */
function boxMap(page: Page): Promise<{ matrix: number[]; decoded: boolean } | null> {
  return page.evaluate((id) => {
    type Tex = {
      updateMatrix: () => void;
      matrix: { toArray: () => number[] };
      image?: { width?: number } | null;
    };
    type O3 = {
      isMesh?: boolean;
      material?: { map?: Tex | null };
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (
      window as unknown as {
        __basher_three: {
          getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
        };
      }
    ).__basher_three.getState().scene;
    let found: { matrix: number[]; decoded: boolean } | null = null;
    scene.getObjectByName(id)?.traverse((o) => {
      const map = o.isMesh ? o.material?.map : null;
      if (!map || found) return;
      map.updateMatrix();
      found = { matrix: map.matrix.toArray(), decoded: (map.image?.width ?? 0) > 0 };
    });
    return found;
  }, BOX);
}

async function expectBoxDrawsPlaced(page: Page, when: string): Promise<void> {
  await expect
    .poll(async () => (await boxMap(page))?.decoded ?? false, { message: when })
    .toBe(true);
  const { matrix } = (await boxMap(page))!;
  for (let i = 0; i < 9; i++)
    expect(matrix[i], `${when}, entry ${i}`).toBeCloseTo(PLACED_UV_MATRIX[i], 9);
}

test('#1139 — a textured box keeps its texture and placement through Apply, save and reload', async ({
  page,
}) => {
  test.slow(); // an import, a material edit, an Apply, a save and a reload, each observed
  await page.goto('/');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('basher', { recursive: true });
    } catch {
      /* not present */
    }
  });
  await page.reload();
  await waitForEditor(page);

  // A project image, stored the way a native import stores one.
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/assets/albedo-textured-quad.gltf').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as W).__basher_ingestGltfFolder!(
      [{ relativePath: 'albedo-textured-quad.gltf', bytes }],
      'p1139',
    );
  });
  await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');
  const source = (await firstMaterialMesh(page))!.slots[0] as { maps: { albedo: unknown } };
  expect(source.maps.albedo).toMatchObject({ store: 'project' });

  // A box drawing that image at tiling [2,2].
  await page.evaluate(
    ({ ops, boxId, dataId, albedo }) => {
      const dag = (window as unknown as W).__basher_dag!;
      const sceneId = dag.getState().state.outputs.scene!.node;
      dag.getState().dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: boxId, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'user',
        'p1139 box',
      );
      const material = dag.getState().state.nodes[dataId].params.material as Record<
        string,
        unknown
      >;
      dag.getState().dispatchAtomic(
        [
          {
            type: 'setParam',
            nodeId: dataId,
            paramPath: 'material',
            value: {
              ...material,
              maps: { ...(material.maps as object), albedo },
              uvTransform: { tiling: [2, 2], offset: [0, 0], rotation: 0 },
            },
          },
        ],
        'user',
        'p1139 texture',
      );
    },
    {
      ops: splitCubeOps({ objectId: BOX, position: [3, 0, 0] }),
      boxId: BOX,
      dataId: splitCubeDataId(BOX),
      albedo: source.maps.albedo,
    },
  );
  await expectBoxDrawsPlaced(page, 'the box before Apply');

  const result = await page.evaluate(async (id) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean };
  }, BOX);
  expect(result.ok).toBe(true);
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const nodes = (window as unknown as W).__basher_dag!.getState().state.nodes;
        const data = (nodes[id] as unknown as { inputs?: { data?: { node: string } } }).inputs
          ?.data;
        return data ? nodes[data.node]?.type : null;
      }, BOX),
    )
    .toBe('BakedData');
  await expectBoxDrawsPlaced(page, 'the baked box after Apply');

  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId, 'the editor has a current project to save into').not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as W;
          if (!(await w.__basher_opfs!.exists(path))) return false;
          const text = new TextDecoder().decode(await w.__basher_opfs!.read(path));
          return text.includes('BakedData') && text.includes('mapPlacements');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.reload();
  await waitForEditor(page);
  await expectBoxDrawsPlaced(page, 'the baked box after reload');
});

// p1136 — Apply keeps a texture's placement, through save and reload.
//
// `uv-transform-quad.gltf` samples its base-colour texture at scale [2,3], offset [0.1,0.2]. Before
// #1136 the bake kept the texture but not its placement: the baked mesh drew the image once,
// untransformed (UV matrix identity), and Apply said ok. The baked mesh places about the centre, so
// its offset differs from the file's; what must match is the UV matrix three builds, read here off
// the live texture of the baked box.
//
// #1053 — the case baked a clone-road import; it now bakes the file's material on a box (the one live
// producer of a textured `BakedData`, see `_bakeOnBox`), through the same baked builder.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`bakedSpecFromInline`),
//      src/viewport/SceneFromDAG.tsx (`BakedMeshR`), src/nodes/BakedData.ts; issue #1136.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { applyBox, boxWithImportedMaterial } from './_bakeOnBox';

interface W {
  __basher_dag?: { getState: () => { state: { outputs: { scene?: unknown } } } };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_ingestGltfFolder?: unknown;
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

const BOX = 'n_p1136_box';
// three's `Matrix3.setUvTransform` for the file's placement about the UV origin (column-major).
const FILE_UV_MATRIX = [2, 0, 0, 0, 3, 0, 0.1, 0.2, 1];

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

/** The base-colour UV matrix of each textured mesh the box draws. */
function boxMapMatrices(page: Page): Promise<number[][]> {
  return page.evaluate((id) => {
    type Tex = { updateMatrix: () => void; matrix: { toArray: () => number[] } };
    type O3 = {
      isMesh?: boolean;
      material?: { map?: Tex | null } | { map?: Tex | null }[];
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (
      window as unknown as {
        __basher_three: {
          getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
        };
      }
    ).__basher_three.getState().scene;
    const out: number[][] = [];
    scene.getObjectByName(id)?.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m?.map) continue;
        m.map.updateMatrix();
        out.push(m.map.matrix.toArray());
      }
    });
    return out;
  }, BOX);
}

async function expectBoxDrawnAsTheFile(page: Page, when: string): Promise<void> {
  await expect.poll(async () => (await boxMapMatrices(page)).length, { message: when }).toBe(1);
  const [matrix] = await boxMapMatrices(page);
  for (let i = 0; i < 9; i++)
    expect(matrix[i], `${when}, entry ${i}`).toBeCloseTo(FILE_UV_MATRIX[i], 9);
}

test('#1136 — a baked mesh draws its texture placed as the file places it, and after reload', async ({
  page,
}) => {
  test.slow(); // an import, an Apply, a save and a reload, each observed
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

  await boxWithImportedMaterial(page, 'uv-transform-quad.gltf', 'p1136', BOX);
  await expectBoxDrawnAsTheFile(page, 'the box before Apply');
  await applyBox(page, BOX);
  await expectBoxDrawnAsTheFile(page, 'the baked box after Apply');

  const projectId = await page.evaluate(() => localStorage.getItem('basher.lastProjectId'));
  expect(projectId, 'the editor has a current project to save into').not.toBeNull();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () =>
        page.evaluate(async (path) => {
          const w = window as unknown as W;
          if (!(await w.__basher_opfs!.exists(path))) return false;
          return new TextDecoder()
            .decode(await w.__basher_opfs!.read(path))
            .includes('mapPlacements');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.reload();
  await waitForEditor(page);
  await expectBoxDrawnAsTheFile(page, 'the baked box after reload');
});

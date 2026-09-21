// p1136 — Apply on an imported child keeps its texture placement, through save and reload.
//
// `uv-transform-quad.gltf` samples its base-colour texture at scale [2,3], offset [0.1,0.2]. On the
// clone road three draws that about the UV origin. Before #1136 the bake kept the texture but not
// its placement: the baked mesh drew the image once, untransformed (UV matrix identity), and Apply
// said ok. The baked mesh places about the centre, so its offset differs from the file's; what must
// match is the UV matrix three builds, read here off the live texture of every VISIBLE mesh.
//
// REF: src/app/animate/captureBakedMaterial.ts (`bakedMapPlacements`),
//      src/viewport/SceneFromDAG.tsx (`BakedMeshR`), src/nodes/BakedData.ts; issue #1136.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { importedChildren } from './_importedChild';

interface W {
  __basher_dag?: { getState: () => { state: { outputs: { scene?: unknown } } } };
  __basher_three?: { getState: () => { scene: unknown } };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (ref: string, bytes: Uint8Array) => Promise<void>;
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

const ASSET_REF = 'assets/uv-transform-quad.gltf';
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
        w.__basher_importGltf &&
        w.__basher_opfs,
      );
    },
    { timeout: 20_000 },
  );
}

/** The base-colour UV matrix of every visible textured mesh in the scene. */
function visibleMapMatrices(page: Page): Promise<number[][]> {
  return page.evaluate(() => {
    type Tex = { updateMatrix: () => void; matrix: { toArray: () => number[] } };
    type O3 = {
      isMesh?: boolean;
      visible: boolean;
      parent: O3 | null;
      material?: { map?: Tex | null } | { map?: Tex | null }[];
    };
    const scene = (
      window as unknown as {
        __basher_three: {
          getState: () => { scene: { traverse: (f: (o: O3) => void) => void } };
        };
      }
    ).__basher_three.getState().scene;
    const out: number[][] = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (let p: O3 | null = o; p; p = p.parent) if (!p.visible) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m?.map) continue;
        m.map.updateMatrix();
        out.push(m.map.matrix.toArray());
      }
    });
    return out;
  });
}

async function expectOneDrawnAsTheFile(page: Page, when: string): Promise<void> {
  await expect.poll(async () => (await visibleMapMatrices(page)).length, { message: when }).toBe(1);
  const [matrix] = await visibleMapMatrices(page);
  for (let i = 0; i < 9; i++)
    expect(matrix[i], `${when}, entry ${i}`).toBeCloseTo(FILE_UV_MATRIX[i], 9);
}

test('#1136 — a baked imported child draws its texture placed as before, and after reload', async ({
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

  // The clone road, which is the only road whose Apply bakes a textured child.
  await page.evaluate(async (ref) => {
    const w = window as unknown as W;
    const buffer = await fetch(`/${ref}`).then((r) => r.arrayBuffer());
    await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buffer));
    await w.__basher_importGltf!(buffer, ref);
  }, ASSET_REF);
  await expectOneDrawnAsTheFile(page, 'the clone before Apply');

  const [child] = await importedChildren(page, ASSET_REF);
  const result = await page.evaluate(async (id) => {
    const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
    return (await mod.dispatchApplyTransform(id, 'all')) as { ok: boolean };
  }, child.objectId);
  expect(result.ok).toBe(true);
  await expectOneDrawnAsTheFile(page, 'the baked mesh after Apply');

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
  await expectOneDrawnAsTheFile(page, 'the baked mesh after reload');
});

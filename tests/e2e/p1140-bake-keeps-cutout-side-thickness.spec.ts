// p1140 — Apply keeps the cutout, the side and the thickness the box drew with, through save and
// reload.
//
// Before #1140 the baked material spec had no field for any of the three, so a box drawing a 0.4
// cutout, both faces and refracting glass baked into an opaque, front-only, flat-glass box — and
// Apply said ok. Each read here is off the LIVE three.js material of the box's own scene object,
// whose id the bake inherits, because the spec and the DAG were both green over every member of
// this family.
//
// REF: src/app/animate/dispatchApplyTransform.ts (`bakedSpecFromInline`),
//      src/app/animate/captureBakedMaterial.ts (`bakedSurface`),
//      src/viewport/SceneFromDAG.tsx (`bakedSurface`, the draw side); issues #1140, #1139, #1136.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeDataId, splitCubeOps } from './_splitCube';

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
  __basher_opfs?: {
    read: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
  };
}

const BOX = 'n_p1140_box';
const CUTOFF = 0.4;
const THICKNESS = 0.5; // openpbrToThree's DEFAULT_TRANSMISSION_THICKNESS, seeded with transmission
const DOUBLE_SIDE = 2; // THREE.DoubleSide

async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return Boolean(
        w.__basher_dag?.getState().state.outputs.scene &&
        w.__basher_three?.getState().scene &&
        w.__basher_opfs,
      );
    },
    { timeout: 20_000 },
  );
}

/** The box's drawn surface: what a person sees as cutout, sidedness and refraction depth. */
function boxSurface(
  page: Page,
): Promise<{ alphaTest: number; side: number; thickness: number } | null> {
  return page.evaluate((id) => {
    type Mat = { alphaTest?: number; side?: number; thickness?: number };
    type O3 = { isMesh?: boolean; material?: Mat | null; traverse: (f: (o: O3) => void) => void };
    const scene = (
      window as unknown as {
        __basher_three: {
          getState: () => { scene: { getObjectByName: (n: string) => O3 | undefined } };
        };
      }
    ).__basher_three.getState().scene;
    let found: { alphaTest: number; side: number; thickness: number } | null = null;
    scene.getObjectByName(id)?.traverse((o) => {
      if (!o.isMesh || !o.material || found) return;
      found = {
        alphaTest: o.material.alphaTest ?? 0,
        side: o.material.side ?? 0,
        thickness: o.material.thickness ?? 0,
      };
    });
    return found;
  }, BOX);
}

async function expectBoxDrawsSurface(page: Page, when: string): Promise<void> {
  await expect
    .poll(async () => (await boxSurface(page))?.alphaTest ?? null, { message: when })
    .toBe(CUTOFF);
  const surface = (await boxSurface(page))!;
  expect(surface.side, `${when}: draws both faces`).toBe(DOUBLE_SIDE);
  expect(surface.thickness, `${when}: glass refracts through a thickness`).toBeCloseTo(
    THICKNESS,
    9,
  );
}

test('#1140 — a cutout, double-sided, transmissive box keeps all three through Apply, save and reload', async ({
  page,
}) => {
  test.slow(); // a material edit, an Apply, a save and a reload, each observed
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

  await page.evaluate(
    ({ ops, boxId, dataId, cutoff }) => {
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
        'p1140 box',
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
              geometry: {
                ...(material.geometry as object),
                alphaCutoff: cutoff,
                doubleSided: true,
              },
              transmission: { ...(material.transmission as object), weight: 0.5 },
            },
          },
        ],
        'user',
        'p1140 surface',
      );
    },
    {
      ops: splitCubeOps({ objectId: BOX, position: [3, 0, 0] }),
      boxId: BOX,
      dataId: splitCubeDataId(BOX),
      cutoff: CUTOFF,
    },
  );
  await expectBoxDrawsSurface(page, 'the box before Apply');

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
  await expectBoxDrawsSurface(page, 'the baked box after Apply');

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
          return text.includes('BakedData') && text.includes('alphaTest');
        }, `projects/${projectId}/project.json`),
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.reload();
  await waitForEditor(page);
  await expectBoxDrawsSurface(page, 'the baked box after reload');
});

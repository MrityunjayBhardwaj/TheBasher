// A glTF file's material, baked: the file imported native (so its images are project images), its
// whole material given to a split box the way the inspector's material copy would, and the box
// Applied, which bakes a primitive into a `BakedData` (#1139). What the box then draws comes from
// the baked mesh's own builder — the one every saved `BakedData` draws through.
//
// #1053 — the "a bake keeps …" cases used to reach that builder by Applying a clone-road import. The
// clone road is retired, and a native import's Apply writes into its stored mesh instead of baking
// (`applyRoadOf`), so a primitive is the one live producer of a textured `BakedData` left.
//
// REF: tests/e2e/p1139-primitive-bake-keeps-maps.spec.ts (the pattern);
//      src/app/animate/dispatchApplyTransform.ts (`applyRoadOf`, `bakedSpecFromInline`); issue #1053.

import { expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCubeDataId, splitCubeOps } from './_splitCube';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          { type: string; params: Record<string, unknown>; inputs?: Record<string, unknown> }
        >;
      };
      dispatchAtomic: (ops: unknown[], source: string, label: string) => void;
    };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

const dataTypeOf = (page: Page, objectId: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const data = nodes[id]?.inputs?.data as { node?: string } | undefined;
    return data?.node ? (nodes[data.node]?.type ?? null) : null;
  }, objectId);

/**
 * Import `/assets/<file>` native into `folder`, give its material to a new box `boxId` beside it,
 * and return once the box holds it. Call {@link applyBox} to bake it.
 */
export async function boxWithImportedMaterial(
  page: Page,
  file: string,
  folder: string,
  boxId: string,
): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return typeof w.__basher_ingestGltfFolder === 'function' && Boolean(w.__basher_dag);
  });
  await page.evaluate(
    async ({ file, folder }) => {
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await (window as unknown as W).__basher_ingestGltfFolder(
        [{ relativePath: file, bytes }],
        folder,
      );
    },
    { file, folder },
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.values((window as unknown as W).__basher_dag.getState().state.nodes).filter(
            (n) => n.type === 'PolyMeshData',
          ).length,
      ),
    )
    .toBe(1);
  await page.evaluate(
    ({ ops, boxId, dataId }) => {
      const dag = (window as unknown as W).__basher_dag;
      const state = dag.getState().state;
      const imported = Object.values(state.nodes).find((n) => n.type === 'PolyMeshData')!;
      const material = (imported.params as { material: unknown }).material;
      const sceneId = state.outputs.scene!.node;
      dag.getState().dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: boxId, socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
          { type: 'setParam', nodeId: dataId, paramPath: 'material', value: material },
        ],
        'user',
        'box with the imported material',
      );
    },
    {
      ops: splitCubeOps({ objectId: boxId, position: [3, 0, 0] }),
      boxId,
      dataId: splitCubeDataId(boxId),
    },
  );
}

/** Apply `boxId` (all bands) and wait until it draws a `BakedData`. */
export async function applyBox(page: Page, boxId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const url = '/src/app/animate/dispatchApplyTransform.ts';
    const mod = (await import(/* @vite-ignore */ url)) as {
      dispatchApplyTransform: (
        id: string,
        what: 'all',
      ) => Promise<{ ok: boolean; reason?: string }>;
    };
    return mod.dispatchApplyTransform(id, 'all');
  }, boxId);
  expect(result, 'the box bakes').toMatchObject({ ok: true });
  await expect.poll(() => dataTypeOf(page, boxId)).toBe('BakedData');
}

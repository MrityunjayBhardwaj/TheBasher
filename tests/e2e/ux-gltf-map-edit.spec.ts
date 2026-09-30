// #178 (S5) — the inspector's map rows on an imported glTF material: clear writes the CLEARED_MAP
// sentinel, revert restores null (inherit the imported texture).
//
// #1053 — the replace case ("the rendered clone shows the picked texture") retired with the clone
// renderer; replacing a map on a native import and seeing it drawn is
// `p997-replaced-map-uv-set.spec.ts`. The case left here reads the DAG and the inspector only.

import { test, expect } from './_fixtures';
import { ingestOnCloneRoad } from './_cloneRoadImport';
import { openInspectorSection } from './_inspectorSections';
import { importedChild } from './_importedChild';

interface W {
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
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  // #1063 — the clone road on purpose: cube-draco now arrives native through ingest.
  await ingestOnCloneRoad(page, 'cube-draco.glb', 'mapedit');
}

async function cubeChild(page: import('@playwright/test').Page) {
  {
    const c = await importedChild(page, 'cube');
    return c
      ? {
          id: c.dataId,
          objectId: c.objectId,
          albedo: (c.slots[0] as { maps: { albedo: unknown } }).maps.albedo,
        }
      : null;
  }
}

test.describe('#178 S5 — editable glTF map rows', () => {
  test('clear writes the CLEARED_MAP sentinel; revert restores null', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect.poll(async () => (await cubeChild(page))?.id ?? null).not.toBeNull();
    const child = await cubeChild(page);
    await page.evaluate((id) => {
      (window as unknown as W).__basher_selection.getState().select(id);
    }, child!.id);
    await openInspectorSection(page, 'material');

    // Clear → the IR slot becomes the empty-hash sentinel.
    await page.getByTestId(`inspector-map-clear-${child!.id}-albedo`).click();
    await expect
      .poll(async () => (await cubeChild(page))?.albedo as { hash?: string } | null)
      .toEqual(expect.objectContaining({ hash: '' }));
    await expect(page.getByTestId(`inspector-map-state-${child!.id}-albedo`)).toHaveText(
      '— cleared',
    );

    // Revert → back to null (inherit imported).
    await page.getByTestId(`inspector-map-revert-${child!.id}-albedo`).click();
    await expect.poll(async () => (await cubeChild(page))?.albedo ?? 'NULL').toBe('NULL');
  });
});

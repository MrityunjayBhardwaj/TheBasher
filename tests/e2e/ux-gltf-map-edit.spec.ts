// #178 (S5) — the GltfMaterialEditor's Maps section is EDITABLE: replace a glTF
// material's texture map (pick a file → attachMapFromFile bakes it to OPFS → the
// IR map ref) and the rendered clone shows the new texture; clear writes the
// CLEARED_MAP sentinel.
//
// THE PROOF (falsifiable, real decode on a live render): import cube-draco (its
// material has NO base-colour map → hasMap false). Pick an albedo file in the
// inspector → the DAG materials[0].maps.albedo becomes a real BakedTextureRef AND
// the rendered clone now HAS a base map (hasMap true). This exercises the full
// loop: bake → setParam → overlay async-loads → render.

import { test, expect } from './_fixtures';

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
  __basher_gltf_meshes?: () => { name: string; color: string | null; hasMap: boolean }[];
}

// A minimal valid 1×1 PNG (red) for the file picker — attachMapFromFile decodes
// it via the real TextureLoader in the browser.
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngBuffer(): Buffer {
  return Buffer.from(RED_PNG_B64, 'base64');
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'mapedit');
  });
}

function cubeChild(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as W;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
    );
    return c
      ? {
          id: c.id,
          albedo: (c.params.materials as { maps: { albedo: unknown } }[] | undefined)?.[0].maps
            .albedo,
        }
      : null;
  });
}

const cubeHasMap = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as W;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find(
      (s) => s.name === 'cube',
    );
    return m ? m.hasMap : null;
  });

test.describe('#178 S5 — editable glTF map rows', () => {
  test('replacing the albedo map paints the imported clone with the picked texture', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as W).__basher_ingestGltfFolder === 'function',
    );
    await ingestCube(page);
    await expect.poll(async () => (await cubeChild(page))?.id ?? null).not.toBeNull();
    const child = await cubeChild(page);
    // cube-draco has no base-colour map.
    await expect.poll(() => cubeHasMap(page)).toBe(false);

    await page.evaluate((id) => {
      (window as unknown as W).__basher_selection.getState().select(id);
    }, child!.id);
    await page.getByTestId('inspector-section-toggle-material').click();

    // The Maps section shows the albedo slot as "— none": cube-draco has NO
    // base-colour texture, so nothing is captured/inherited (the texture-maps
    // milestone distinguishes an empty slot from an "● imported" captured one).
    const stateTag = page.getByTestId(`inspector-gltfmap-state-${child!.id}-0-albedo`);
    await expect(stateTag).toHaveText('— none');

    // Pick a file → bake → the IR ref is set + the clone repaints with a map.
    await page
      .getByTestId(`inspector-gltfmap-file-${child!.id}-0-albedo`)
      .setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: pngBuffer() });

    // Side A: the DAG map ref is a real (non-null, non-empty) BakedTextureRef.
    await expect
      .poll(async () => {
        const a = (await cubeChild(page))?.albedo as { hash?: string } | null | undefined;
        return a && typeof a.hash === 'string' && a.hash.length > 0 ? 'ref' : 'none';
      })
      .toBe('ref');
    // Side B: the rendered clone now carries a base map (overlay loaded + applied).
    await expect.poll(() => cubeHasMap(page)).toBe(true);
    await expect(stateTag).toHaveText('● replaced');
  });

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
    await page.getByTestId('inspector-section-toggle-material').click();

    // Clear → the IR slot becomes the empty-hash sentinel.
    await page.getByTestId(`inspector-gltfmap-clear-${child!.id}-0-albedo`).click();
    await expect
      .poll(async () => (await cubeChild(page))?.albedo as { hash?: string } | null)
      .toEqual(expect.objectContaining({ hash: '' }));
    await expect(page.getByTestId(`inspector-gltfmap-state-${child!.id}-0-albedo`)).toHaveText(
      '— cleared',
    );

    // Revert → back to null (inherit imported).
    await page.getByTestId(`inspector-gltfmap-revert-${child!.id}-0-albedo`).click();
    await expect.poll(async () => (await cubeChild(page))?.albedo ?? 'NULL').toBe('NULL');
  });
});

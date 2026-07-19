// v0.6 #2 (#178) W5 — texture maps land on the REAL material with the correct
// colorspace, AND a load failure SURFACES (no silent drop). Side-A is the real
// three.js mesh.material via __basher_mesh_material. The OPFS round-trip is
// proven end-to-end: attach → persistTexture(OPFS) → useBakedTexture loads from
// OPFS → renders (hasMap + mapImageOk). FALSIFY: break the colorspace assignment
// → the srgb assertion goes RED (done in the W7 sweep).

// #365 Slice 2: the default box is a split Object (`n_box`) → BoxData
// (`n_box_data`) which owns the material. Selecting the Object makes the inspector
// render the material (and its map rows) keyed to the DATA node, so the map-file
// input and the asset-error row live on `n_box_data`; the rendered mesh read
// (`__basher_mesh_material`) stays on the Object `n_box`.

import { expect, test } from './_fixtures';

interface MeshMaterial {
  hasMap: boolean;
  mapImageOk: boolean;
  mapColorSpace: string | null;
}
interface BasherWindow {
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
}

async function selectBoxAndOpenMaterial(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_selection) && typeof w.__basher_mesh_material === 'function';
  });
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box');
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  const editor = page.getByTestId('inspector-material-editor-n_box_data');
  if (!(await editor.isVisible())) {
    await page.getByTestId('inspector-section-toggle-material').click();
  }
  await expect(editor).toBeVisible();
}

test.describe('v0.6 #2 W5 — texture maps on the real material', () => {
  test('attach an albedo PNG → real mesh.material.map set, sRGB, survives OPFS round-trip', async ({
    page,
  }) => {
    await selectBoxAndOpenMaterial(page);

    // Pick a real PNG into the albedo slot (the hidden file input is set directly).
    await page
      .getByTestId('inspector-map-file-n_box_data-albedo')
      .setInputFiles('public/fixtures/multifile/flat/texture.png');

    // The renderer loads the persisted map back from OPFS via useBakedTexture —
    // hasMap + a decoded image + sRGB proves the FULL persist→load→render trip.
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const m = w.__basher_mesh_material!('n_box');
      return m != null && m.hasMap && m.mapImageOk;
    });
    const mat = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_material!('n_box'),
    );
    console.log(`[p06-2 maps] ${JSON.stringify(mat)}`);
    // Side-A = the REAL three.js material.map.
    expect(mat!.hasMap).toBe(true);
    expect(mat!.mapImageOk).toBe(true);
    expect(mat!.mapColorSpace).toBe('srgb'); // albedo is colour data (D-04)
  });

  test('a corrupt image SURFACES via assetErrorStore (no silent drop)', async ({ page }) => {
    await selectBoxAndOpenMaterial(page);

    // 4 garbage bytes as a .png → TextureLoader decode fails → MapRow catches and
    // reports to assetErrorStore → the AssetErrorBanner renders the failure row.
    await page.getByTestId('inspector-map-file-n_box_data-albedo').setInputFiles({
      name: 'bad.png',
      mimeType: 'image/png',
      buffer: Buffer.from([1, 2, 3, 4]),
    });

    const banner = page.getByTestId('asset-error-banner');
    await expect(banner).toBeVisible();
    await expect(page.getByTestId('asset-error-row-n_box_data:albedo')).toBeVisible();
  });
});

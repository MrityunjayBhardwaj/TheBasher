// #550 — the per-map UV placement is READABLE and RESETTABLE in the inspector.
//
// ── WHY THIS SPEC EXISTS AT ALL, measured rather than assumed ─────────────────
//
// Deleting every per-map row from `NPanel` leaves the entire 3779-test unit tier
// GREEN. `NPanel.tsx` has no unit tier, so nothing below the browser can observe
// that these rows render, carry the captured numbers, or write what they claim to.
// The pure read/write rule underneath them IS unit-gated
// (`perMapPlacementEdit.gate.test.ts`); this file covers the half that gate cannot
// see, and it is the only tier that can.
//
// ── THE DEFECT IT PINS ────────────────────────────────────────────────────────
//
// A glTF whose maps carry differing KHR_texture_transforms imports with each slot's
// absolute placement in `mapUvTransforms` and a SHARED placement left at IDENTITY —
// identity is load-bearing there, because the glTF road treats it as a no-op, which
// is what made the import slice unable to regress the viewport. The consequence for
// the panel is that the one "Texture Placement" section read tiling [1,1] while the
// viewport drew the quad at [2,3]. The rows below fix exactly that.
//
// ── THE PROOF (boundary-pair, both sides, every time) ─────────────────────────
//
// Side A is the DAG param (the imported `PolyMeshData.material`), side B is the LIVE
// three.js material the import draws, read per filled slot — a single-slot probe cannot
// observe a per-SLOT claim. Each slot's `repeat` is its tiling on either pivot. Every assertion names the
// OTHER slot as a control in the same run, because "this slot moved" and "every slot
// moved" are the same picture when only one slot is read.
//
// ⚠️ THE RESET IS OBSERVED AGAINST A NON-IDENTITY SHARED PLACEMENT ON PURPOSE: resetting a
// slot back to an identity shared value would draw what an untouched slot draws, so "correct
// fallback" would be indistinguishable from "nothing ran". Editing the shared placement first
// makes the fallback discriminating.
//
// REF: src/app/NPanel.tsx (the rows), src/app/material/perMapPlacementEdit.ts (the
//      rule); issues #550, #551, #217, #181.
//
// #1053 — the fixture imports native (the importer keeps `mapUvTransforms`); the clone road
// this spec used to stage on is retired.

import { test, expect } from './_fixtures';
import { openInspectorSection } from './_inspectorSections';
import { firstMaterialMesh, importRoots } from './_importedMesh';

interface BasherWindow {
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

/**
 * The shipped uv-transform-quad fixture, given a SECOND textured slot with a
 * DIFFERENT KHR_texture_transform. It reuses texture 0, so this needs no new image
 * asset (the image-asset fixture is its own slice). This is the per-map case.
 */
async function ingestPerMap(page: import('@playwright/test').Page, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(async (name) => {
    const w = window as unknown as BasherWindow;
    const json = await fetch('/assets/uv-transform-quad.gltf').then((r) => r.json());
    json.materials[0].emissiveTexture = {
      index: 0,
      extensions: { KHR_texture_transform: { offset: [0.5, 0.5], scale: [4, 4], rotation: 0.25 } },
    };
    json.materials[0].emissiveFactor = [1, 1, 1];
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    await w.__basher_ingestGltfFolder([{ relativePath: `${name}.gltf`, bytes }], name);
  }, folder);
  await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');
}

/** The imported child + the shape of its slot-0 material (side A). */
async function materialChild(page: import('@playwright/test').Page) {
  {
    const c0 = await firstMaterialMesh(page);
    if (!c0) return null;
    const m0 = c0.slots[0] as Record<string, unknown>;
    return {
      id: c0.dataId,
      objectId: c0.objectId,
      ownKeys: Object.keys(m0),
      uvTransform: m0.uvTransform as { tiling: [number, number] },
      perMap: m0.mapUvTransforms as
        | Record<string, { tiling: [number, number]; offset: [number, number]; rotation: number }>
        | undefined,
    };
  }
}

/** The LIVE drawn material's per-slot placements (side B): each filled slot's `repeat`. */
async function drawn(
  page: import('@playwright/test').Page,
): Promise<Record<string, { repeat: [number, number] }> | null> {
  const roots = await importRoots(page);
  if (roots.length !== 1) return null;
  return page.evaluate((id) => {
    type Tex = { repeat: { x: number; y: number } } | null | undefined;
    type O3 = {
      isMesh?: boolean;
      material?: Record<string, Tex>;
      traverse: (f: (o: O3) => void) => void;
    };
    const scene = (
      window as unknown as {
        __basher_three: { getState: () => { scene: { getObjectByName: (n: string) => O3 } } };
      }
    ).__basher_three.getState().scene;
    let out: Record<string, { repeat: [number, number] }> | null = null;
    scene.getObjectByName(id)?.traverse((o) => {
      if (!o.isMesh || out || !o.material) return;
      const found: Record<string, { repeat: [number, number] }> = {};
      for (const slot of ['map', 'emissiveMap']) {
        const t = o.material[slot];
        if (t) found[slot] = { repeat: [t.repeat.x, t.repeat.y] };
      }
      out = found;
    });
    return out;
  }, roots[0].rootId);
}

async function selectAndOpen(
  page: import('@playwright/test').Page,
  child: { id: string; objectId: string },
) {
  await page.evaluate((nid) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(nid);
  }, child.objectId);
  await openInspectorSection(page, 'material');
  await expect(page.getByTestId(`inspector-material-editor-${child.id}`)).toBeVisible();
}

async function importedChild(page: import('@playwright/test').Page, folder: string) {
  await ingestPerMap(page, folder);
  await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
  const child = await materialChild(page);
  await selectAndOpen(page, child!);
  return child!;
}

test.describe('#550 — per-map UV placement in the inspector', () => {
  test('the captured per-map placements are shown, and the shared row says it is shared', async ({
    page,
  }) => {
    const child = await importedChild(page, 'pm-read');

    // Both maps carry their own placement, so both get a row. The SHARED section
    // still renders (a slot with no entry uses it) but no longer claims to govern
    // every map — which is the read-side defect: it sits at identity here.
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}-albedo`)).toBeVisible();
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}-emissive`)).toBeVisible();
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}`)).toContainText(
      'Texture Placement · shared',
    );

    // The numbers in the rows are the CAPTURED ones, per slot, not the shared value.
    await expect(page.getByTestId(`inspector-uvtransform-tilingX-${child.id}-albedo`)).toHaveValue(
      '2',
    );
    await expect(page.getByTestId(`inspector-uvtransform-tilingY-${child.id}-albedo`)).toHaveValue(
      '3',
    );
    await expect(
      page.getByTestId(`inspector-uvtransform-tilingX-${child.id}-emissive`),
    ).toHaveValue('4');
    await expect(
      page.getByTestId(`inspector-uvtransform-rotation-${child.id}-emissive`),
    ).toHaveValue('0.25');

    // And the shared value really is identity — so an unlabelled shared section
    // would have been the panel disagreeing with a viewport drawing [2,3].
    expect((await materialChild(page))?.uvTransform.tiling).toEqual([1, 1]);

    // A slot with no texture gets no row (rows are per PRESENT placement).
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}-normal`)).toHaveCount(0);
  });

  test('editing one map’s placement re-places THAT map only, in the DAG and on screen', async ({
    page,
  }) => {
    const child = await importedChild(page, 'pm-edit');
    await expect.poll(async () => (await drawn(page))?.map?.repeat).toEqual([2, 3]);
    await expect.poll(async () => (await drawn(page))?.emissiveMap?.repeat).toEqual([4, 4]);

    const tilingX = page.getByTestId(`inspector-uvtransform-tilingX-${child.id}-albedo`);
    await tilingX.fill('7');
    await tilingX.blur();

    // Side A — only albedo's entry moved; emissive is untouched, and the SHARED
    // value is untouched too (replacement, never composition).
    await expect
      .poll(async () => (await materialChild(page))?.perMap?.albedo?.tiling)
      .toEqual([7, 3]);
    expect((await materialChild(page))?.perMap?.emissive?.tiling).toEqual([4, 4]);
    expect((await materialChild(page))?.uvTransform.tiling).toEqual([1, 1]);

    // Side B — the drawn material agrees, and the control slot did NOT move.
    await expect.poll(async () => (await drawn(page))?.map?.repeat).toEqual([7, 3]);
    expect((await drawn(page))?.emissiveMap?.repeat).toEqual([4, 4]);
  });

  test('reset returns the map to the shared placement and removes the entry', async ({ page }) => {
    const child = await importedChild(page, 'pm-reset');

    // FIRST make the shared placement non-identity, through the shared row. Without
    // this the fallback is unobservable: the road skips a slot resolving to identity,
    // so a correct reset and a reset that never ran draw the same thing.
    const sharedX = page.getByTestId(`inspector-uvtransform-tilingX-${child.id}`);
    await sharedX.fill('9');
    await sharedX.blur();
    await expect.poll(async () => (await materialChild(page))?.uvTransform.tiling?.[0]).toBe(9);
    // The per-map slots IGNORE it — that is what replacement means, and it is also
    // the vacuity guard for the reset below.
    await expect.poll(async () => (await drawn(page))?.map?.repeat).toEqual([2, 3]);

    await page.getByTestId(`inspector-uvtransform-reset-${child.id}-albedo`).click();

    // Side A — albedo's key is gone; emissive's remains, so the field remains.
    await expect.poll(async () => (await materialChild(page))?.perMap?.albedo).toBeUndefined();
    expect(Object.keys((await materialChild(page))?.perMap ?? {})).toEqual(['emissive']);
    // Side B — albedo now draws the SHARED placement; emissive keeps its own.
    await expect.poll(async () => (await drawn(page))?.map?.repeat).toEqual([9, 1]);
    expect((await drawn(page))?.emissiveMap?.repeat).toEqual([4, 4]);
    // The row is gone with the entry, and the shared header stops saying "· shared"
    // only once NO map has its own — emissive still does, so it still says it.
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}-albedo`)).toHaveCount(0);

    // Resetting the LAST entry must remove the FIELD itself, not leave an empty bag:
    // an empty-but-present bag renders identically and keys differently, re-minting
    // every material on the next load with nothing visible to explain it.
    await page.getByTestId(`inspector-uvtransform-reset-${child.id}-emissive`).click();
    await expect
      .poll(async () => (await materialChild(page))?.ownKeys.includes('mapUvTransforms'))
      .toBe(false);
    await expect.poll(async () => (await drawn(page))?.emissiveMap?.repeat).toEqual([9, 1]);
    await expect(page.getByTestId(`inspector-uvtransform-${child.id}`)).toContainText(
      'Texture Placement',
    );
  });
});

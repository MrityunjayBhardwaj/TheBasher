// #553 — a texture REPLACED from the inspector must draw with its slot's UV placement.
//
// ── WHY THIS SPEC IS LOAD-BEARING, NOT CONFIRMATORY ────────────────────────────────────
//
// `replacedMapPlacement.gate.test.ts` proves `applyEditedMaps` places what it is handed.
// It cannot prove the CALLER hands it anything. Measured, not assumed: reverting the call
// site in `SceneFromDAG` to pass an identity placement — which reinstates exactly the
// user-visible defect — leaves all 3798 unit tests GREEN, because nothing below the
// browser exercises that wiring. So the unit gate and this file cover different halves,
// and neither is redundant with the other.
//
// ── HOW THE REPLACEMENT IS PROVEN TO HAVE LANDED, AND WHY IT IS NOT THE OBVIOUS CHECK ──
//
// The map pass is ASYNC. The first probe of this defect polled the DAG param to confirm
// the replacement, then read the drawn placement — and got a reading byte-identical to
// the one before the replacement, INCLUDING the control, which reads as "the placement
// survived". It had not: the texture simply had not reached the render yet, so the probe
// was still measuring the OLD texture's placement.
//
// So the landed-check keys on the artefact's OWN identity — the drawn image goes 64×64
// (the fixture's) to 1×1 (the replacement's) — a property the placement question cannot
// influence in either direction. Polling the property under test would be circular.
//
// ── BOTH HALVES, EVERY CASE ───────────────────────────────────────────────────────────
//
// The replaced slot must gain its placement AND an untouched slot must keep its own, in
// the SAME run. "The replaced one is right" alone passes a build that places every slot
// identically; "the control is unchanged" alone passes a build that places nothing.
//
// REF: src/app/material/gltfMapOverlay.ts (`applyEditedMaps` — the subject),
//      src/viewport/SceneFromDAG.tsx (the call site this file is the only cover for,
//      and the `__basher_gltf_meshes` probe it reads), src/app/material/uvPlacement.ts;
//      src/app/material/replacedMapPlacement.gate.test.ts (the unit half);
//      issues #553, #550, #178.

import { test, expect, type Page } from './_fixtures';

/** A 1×1 red PNG — the replacement, chosen so its DIMENSIONS identify it. */
const RED_PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface SlotPlacement {
  repeat: [number, number];
  offset: [number, number];
  rotation: number;
  center: [number, number];
}
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
  __basher_gltf_meshes?: () => {
    slotPlacements: Record<string, SlotPlacement>;
    mapProbe?: { imageWidth?: number } | null;
  }[];
}

/**
 * What the renderer actually drew: every filled slot's placement, off the live material.
 *
 * `n` rides along deliberately. This reader SELECTS a subject out of a space it does not
 * own — the probe reports every glTF mesh in the scene — and a reader like that is only
 * as trustworthy as its cardinality. Taking `[0]` silently returns the wrong mesh if a
 * second import is present, which reads as a plausible, varied, entirely wrong answer
 * rather than as an obvious null. Every case asserts `n` is 1 before believing the rest.
 */
function drawn(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const all = w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
    const m = all[0];
    return m
      ? { n: all.length, slots: m.slotPlacements, width: m.mapProbe?.imageWidth ?? null }
      : { n: all.length, slots: null, width: null };
  });
}

/** The imported child carrying a captured material, plus its IR placement fields. */
function materialChild(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && Array.isArray(n.params.materials),
    );
    if (!c) return null;
    const m0 = (c.params.materials as Record<string, unknown>[])[0];
    return { id: c.id, maps: m0.maps as Record<string, unknown>, perMap: m0.mapUvTransforms };
  });
}

async function importAndSelect(page: Page, mutate: boolean, folder: string) {
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function',
  );
  await page.evaluate(
    async ({ mutate, folder }) => {
      const w = window as unknown as BasherWindow;
      const json = await fetch('/assets/uv-transform-quad.gltf').then((r) => r.json());
      if (mutate) {
        // Give emissive its OWN placement, so the fixture is per-map-differing and the
        // control slot's expected value is distinct from albedo's.
        json.materials[0].emissiveTexture = {
          index: 0,
          extensions: {
            KHR_texture_transform: { offset: [0.5, 0.5], scale: [4, 4], rotation: 0.25 },
          },
        };
        json.materials[0].emissiveFactor = [1, 1, 1];
      }
      const bytes = new TextEncoder().encode(JSON.stringify(json));
      await w.__basher_ingestGltfFolder([{ relativePath: 'p553.gltf', bytes }], folder);
    },
    { mutate, folder },
  );
  await expect.poll(async () => (await materialChild(page))?.id).toBeTruthy();
  const child = (await materialChild(page))!;
  await page.evaluate((nid) => {
    (window as unknown as BasherWindow).__basher_selection.getState().select(nid);
  }, child.id);
  await page.getByTestId('inspector-section-toggle-material').click();
  // Wait for the FIXTURE's own texture to have reached the render before any premise is
  // read. Without this the `before` snapshot races the import: the DAG node exists well
  // ahead of the decoded image, so the premise assertions sampled a half-built material
  // and reddened on a value that was merely early. Keyed on the image's dimensions, the
  // same artefact-identity check the replacement uses — never on a placement.
  await expect.poll(async () => (await drawn(page)).width).toBe(64);
  return child;
}

/** Replace a slot's texture through the production pick → bake → apply road. */
async function replaceAlbedo(page: Page, childId: string) {
  await page.getByTestId(`inspector-gltfmap-file-${childId}-0-albedo`).setInputFiles({
    name: 'red.png',
    mimeType: 'image/png',
    buffer: Buffer.from(RED_PNG_1PX, 'base64'),
  });
  // The DAG param is the FIRST half of "landed" — necessary, nowhere near sufficient.
  await expect.poll(async () => (await materialChild(page))?.maps?.albedo != null).toBe(true);
  // …and this is the half that matters: the DRAWN texture is the 1×1 replacement, not
  // the fixture's 64×64. Keyed on the artefact's own identity, never on the placement.
  await expect.poll(async () => (await drawn(page))?.width).toBe(1);
}

test('#553 — a replaced map on a PER-MAP import draws with that slot’s own placement', async ({
  page,
}) => {
  const child = await importAndSelect(page, true, 'p553-permap');

  const before = await drawn(page);
  expect(before.n).toBe(1); // premise: ONE glTF mesh, so `[0]` is unambiguous
  expect(before?.slots?.map?.repeat).toEqual([2, 3]); // premise: albedo owns [2,3]
  expect(before?.slots?.emissiveMap?.repeat).toEqual([4, 4]); // premise: emissive owns [4,4]
  expect(before?.width).toBe(64); // premise: the fixture's image, not the replacement's

  await replaceAlbedo(page, child.id);

  const after = await drawn(page);
  expect(after.n).toBe(1);
  // The defect drew [1,1] here — no placement at all.
  expect(after?.slots?.map?.repeat).toEqual([2, 3]);
  expect(after?.slots?.map?.center).toEqual([0, 0]); // the glTF road's pivot (#551)
  // …and the untouched slot is undisturbed, in the same run.
  expect(after?.slots?.emissiveMap?.repeat).toEqual([4, 4]);
});

test('#553 — a replaced map on a UNIFORM import draws with the SHARED placement', async ({
  page,
}) => {
  // The same question with no per-map bag at all. This is the case that proved the
  // defect predates #550: it fails identically on a material that never had per-map
  // placement, so it belongs to the replaced-map road, not to per-map-ness.
  const child = await importAndSelect(page, false, 'p553-uniform');

  expect((await materialChild(page))?.perMap).toBeUndefined(); // premise: no per-map bag
  const before = await drawn(page);
  expect(before.n).toBe(1); // premise: ONE glTF mesh, so `[0]` is unambiguous
  expect(before?.slots?.map?.repeat).toEqual([2, 3]); // the SHARED placement
  expect(before?.width).toBe(64);

  await replaceAlbedo(page, child.id);

  const after = await drawn(page);
  expect(after.n).toBe(1);
  expect(after?.slots?.map?.repeat).toEqual([2, 3]);
  expect(after?.slots?.map?.center).toEqual([0, 0]);
});

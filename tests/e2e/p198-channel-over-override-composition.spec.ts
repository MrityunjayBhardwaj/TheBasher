// #198 (v0.7 Phase 4) — channel-over-MaterialOverride COMPOSITION boundary-pair.
//
// THE PROOF (the V56/p188 method — inject a free-floating channel + wire a real
// override, observe the EVALUATED render): import the textured `metal` fixture
// (it carries a metallicRoughnessTexture → the loader sets `.metalnessMap`, so
// the override does NOT force metalness — the map defends it, #99/#124 D-06) →
// wire a MaterialOverride (#ff0000 colour tint) into the chain via the SAME op
// path the app uses (p7.13, H58 — not a React-prop injection) → inject a
// `material.base.metalness` channel targeting the GltfData node id directly (no
// AnimationLayer, V57) → scrub the playhead.
//
// COMPOSITION = "channel animates the base IR, tint layers on top":
//   - metalness RAMPS 0→1 with the playhead — even though a MaterialOverride
//     claims this slot. Before #198 the override-claimed slot recorded `null` and
//     the per-frame loop SKIPPED it → metalness would FREEZE at its tinted base.
//     The midpoint (0.5) is the falsifiable signal: a frozen slot can never land
//     there.
//   - the FORCED colour STAYS #ff0000 at every frame — the tint wins for its
//     forced channels (reapplyOverride re-layers on top of the animated base).
//     Without the re-tint, the per-frame applyOpenpbrScalars would overwrite the
//     colour with the captured base (#cccccc) and the tint would vanish at t>0.
//
// metalness is the composable field here precisely because the override leaves it
// `null` (map-defended): the channel drives it THROUGH the tint, observable on the
// live three.js material via `_importedMesh.ts` (side A == the rendered surface).
//
// #1072 — the fixture now arrives as native geometry (#1050): the channel targets the
// `PolyMeshData` that owns the material, and the override wraps the ordinary Object
// (`_importOverride.ts`). The road is asserted.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';
import { wrapImportInOverride } from './_importOverride';

interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

const FIXTURE_FILES = ['scene.gltf', 'scene.bin', 'texture.png'];

async function ingestMetal(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async (files) => {
    const w = window as unknown as BasherWindow;
    const payload: { relativePath: string; bytes: Uint8Array }[] = [];
    for (const p of files) {
      const bytes = new Uint8Array(
        await fetch('/fixtures/multifile/metal/' + p).then((r) => r.arrayBuffer()),
      );
      payload.push({ relativePath: p, bytes });
    }
    await w.__basher_ingestGltfFolder(payload, 'mat-compose');
  }, FIXTURE_FILES);
}

// #389 — the DATA half's id. A material channel targets the node that OWNS the param —
// `PolyMeshData` on the native road, `GltfData` on the clone one; aiming it at the Object
// would resolve to a node that exists and a param that does not — visible in the
// dopesheet, driving nothing.
async function boxChildId(page: import('@playwright/test').Page) {
  return (await firstMaterialMesh(page))?.dataId ?? null;
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time.getState().setTime(s);
  }, seconds);
}

const boxSlot = async (page: import('@playwright/test').Page) => {
  const m = (await drawnImportMeshes(page))[0];
  return m ? { color: m.color, metalness: m.metalness, hasMetalnessMap: m.hasMetalnessMap } : null;
};

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function' &&
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_time,
  );
  await ingestMetal(page);
  await expect.poll(() => boxChildId(page)).not.toBeNull();
  expect((await firstMaterialMesh(page))?.road).toBe('native');
  // The fixture must carry a metalnessMap, else the override would FORCE metalness
  // and there would be nothing to compose (the test's premise).
  await expect.poll(async () => (await boxSlot(page))?.hasMetalnessMap).toBe(true);
}

test.describe('#198 — channel-over-MaterialOverride composition (boundary-pair)', () => {
  test('a metalness channel composes THROUGH a colour tint: metalness ramps, colour stays tinted', async ({
    page,
  }) => {
    await ready(page);
    const childId = await boxChildId(page);

    // Wire a MaterialOverride (#ff0000) between the import root Group and its content —
    // the SAME op path the app uses (p7.13). Whole-child (no slotIndex) → tints the
    // slot; metalness is map-defended so the tint leaves it untouched.
    await wrapImportInOverride(page, 'p198_mo', { color: '#ff0000' });

    // The tint lands BEFORE any animation (composition starts from a tint).
    await expect.poll(async () => (await boxSlot(page))?.color).toBe('#ff0000');

    // Free-floating metalness channel — target the GltfData node id directly (V57).
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
        {
          type: 'addNode',
          nodeId: 'p198_metal',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'metalness',
            target: id,
            paramPath: 'material.base.metalness',
            keyframes: [
              { time: 0, value: 0, easing: 'linear' },
              { time: 1, value: 1, easing: 'linear' },
            ],
          },
        },
        'user',
        'p198-seed-metalness-channel',
      );
    }, childId);

    // Side A — the RENDERED clone composes: metalness tracks the channel while the
    // colour stays the FORCED tint at every playhead (the two halves of #198).
    await setTime(page, 0);
    await expect.poll(async () => (await boxSlot(page))?.metalness).toBeCloseTo(0, 2);
    expect((await boxSlot(page))?.color).toBe('#ff0000');

    await setTime(page, 1);
    await expect.poll(async () => (await boxSlot(page))?.metalness).toBeCloseTo(1, 2);
    // The tint MUST survive the animated base write (reapplyOverride re-layers it).
    expect((await boxSlot(page))?.color).toBe('#ff0000');

    // The midpoint proves it TRACKS through the override (a frozen slot stays put).
    await setTime(page, 0.5);
    await expect.poll(async () => (await boxSlot(page))?.metalness).toBeCloseTo(0.5, 2);
    expect((await boxSlot(page))?.color).toBe('#ff0000');
  });
});

// #198 (v0.7 Phase 4) — channel-over-MaterialOverride COMPOSITION boundary-pair.
//
// THE PROOF (the V56/p188 method — inject a free-floating channel + wire a real
// override, observe the EVALUATED render): import the textured `metal` fixture
// (it carries a metallicRoughnessTexture → the loader sets `.metalnessMap`, so
// the override does NOT force metalness — the map defends it, #99/#124 D-06) →
// wire a MaterialOverride (#ff0000 colour tint) into the chain via the SAME op
// path the app uses (p7.13, H58 — not a React-prop injection) → inject a
// `materials.0.base.metalness` channel targeting the GltfChild dagId directly (no
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
// live three.js material via __basher_gltf_meshes (side A == the rendered surface).

import { test, expect } from './_fixtures';

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
  __basher_gltf_meshes?: () => {
    name: string;
    color: string | null;
    metalness: number | null;
    hasMetalnessMap: boolean;
  }[];
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

function boxChildId(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find((n) => n.type === 'GltfChild');
    return c?.id ?? null;
  });
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time.getState().setTime(s);
  }, seconds);
}

const boxSlot = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [])[0];
    return m ? { color: m.color, metalness: m.metalness, hasMetalnessMap: m.hasMetalnessMap } : null;
  });

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

    // Wire a MaterialOverride (#ff0000) between the imported GltfAsset and its
    // Transform — the SAME op path the app uses (p7.13). Whole-child (no slotIndex)
    // → tints the slot; metalness is map-defended so the tint leaves it untouched.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag.getState();
      const nodes = dag.state.nodes;
      const gltfId = Object.keys(nodes).find((id) => nodes[id].type === 'GltfAsset');
      const transformId = Object.keys(nodes).find((id) => nodes[id].type === 'Transform');
      if (!gltfId || !transformId) throw new Error('expected GltfAsset + Transform from import');
      dag.dispatchAtomic(
        [
          {
            type: 'disconnect',
            from: { node: gltfId, socket: 'out' },
            to: { node: transformId, socket: 'target' },
          },
          { type: 'addNode', nodeId: 'p198_mo', nodeType: 'MaterialOverride', params: { color: '#ff0000' } },
          { type: 'connect', from: { node: gltfId, socket: 'out' }, to: { node: 'p198_mo', socket: 'target' } },
          { type: 'connect', from: { node: 'p198_mo', socket: 'out' }, to: { node: transformId, socket: 'target' } },
        ],
        'user',
        'p198 apply material override',
      );
    });

    // The tint lands BEFORE any animation (composition starts from a tint).
    await expect.poll(async () => (await boxSlot(page))?.color).toBe('#ff0000');

    // Free-floating metalness channel — target the GltfChild dagId directly (V57).
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
        {
          type: 'addNode',
          nodeId: 'p198_metal',
          nodeType: 'KeyframeChannelNumber',
          params: {
            name: 'metalness',
            target: id,
            paramPath: 'materials.0.base.metalness',
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

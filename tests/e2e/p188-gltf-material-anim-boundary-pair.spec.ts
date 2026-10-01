// #188 (v0.7 Phase 3) — glTF material-scalar ANIMATION boundary-pair.
//
// THE PROOF (the V56/p197 method — inject a free-floating channel, observe the
// EVALUATED render): import cube-draco → inject a `material.base.metalness`
// KeyframeChannelNumber targeting the cube's data node DIRECTLY (no AnimationLayer —
// the direct-channel road, V57) → scrub the playhead → the RENDERED metalness (read
// off the live three.js material the import draws) RAMPS with time. A
// KeyframeChannelColor on `material.base.color` likewise drives the rendered colour.
//
// #1053 — cube-draco arrives native (#1063) and the clone road is retired, so the cube
// is the native import's `PolyMeshData`.
//
// This is side A == "the channel actually animates the rendered material". The
// resolver side (overlayChannels) is unit-locked (overlayChannels.test.ts); here we
// observe the RENDER follows it per-frame — the H40 displayed≠rendered guard for the
// new material band. If the renderer read raw params.materials instead of the
// channel-overlaid value, metalness would freeze at its captured base.

import { test, expect } from './_fixtures';
import { drawnImportMeshes, firstMaterialMesh } from './_importedMesh';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }>;
      };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await (window as unknown as BasherWindow).__basher_ingestGltfFolder(
      [{ relativePath: 'cube-draco.glb', bytes }],
      'matanim',
    );
  });
}

// #389 — the DATA half's id. A material channel addresses the node that OWNS the param
// (`PolyMeshData`); aimed at the Object it would resolve to a param that does not exist:
// visible in the dopesheet, driving nothing, with nothing failing anywhere.
async function cubeChildId(page: import('@playwright/test').Page) {
  return (await firstMaterialMesh(page))?.dataId ?? null;
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time.getState().setTime(s);
  }, seconds);
}

const cubeSlot = async (page: import('@playwright/test').Page) => {
  const m = (await drawnImportMeshes(page))[0];
  return m ? { color: m.color, metalness: m.metalness } : null;
};

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function' &&
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_time,
  );
  await ingestCube(page);
  await expect.poll(() => cubeChildId(page)).not.toBeNull();
  expect((await firstMaterialMesh(page))?.road).toBe('native');
  await expect.poll(async () => (await cubeSlot(page))?.metalness).not.toBeNull();
}

test.describe('#188 — glTF material-scalar animation (H40 boundary-pair)', () => {
  test('a free-floating metalness channel RAMPS the rendered metalness (0→1 over t∈[0,1])', async ({
    page,
  }) => {
    await ready(page);
    const childId = await cubeChildId(page);

    // Free-floating channel — target the data node id DIRECTLY, no layer (V57).
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
        {
          type: 'addNode',
          nodeId: 'p188_metal',
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
        'p188-seed-metalness-channel',
      );
    }, childId);

    // Side A — the RENDERED metalness tracks the channel at each playhead.
    await setTime(page, 0);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(0, 2);
    await setTime(page, 1);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(1, 2);
    // The midpoint proves it TRACKS (a static read would never land at 0.5).
    await setTime(page, 0.5);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(0.5, 2);
  });

  test('a free-floating base.color channel drives the rendered colour', async ({ page }) => {
    await ready(page);
    const childId = await cubeChildId(page);

    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
        {
          type: 'addNode',
          nodeId: 'p188_color',
          nodeType: 'KeyframeChannelColor',
          params: {
            name: 'base color',
            target: id,
            paramPath: 'material.base.color',
            keyframes: [
              { time: 0, value: '#ff0000', easing: 'linear' },
              { time: 2, value: '#0000ff', easing: 'linear' },
            ],
          },
        },
        'user',
        'p188-seed-color-channel',
      );
    }, childId);

    // At t=0 the rendered colour is the first keyframe (red); at t=2 the last (blue).
    await setTime(page, 0);
    await expect.poll(async () => (await cubeSlot(page))?.color).toBe('#ff0000');
    await setTime(page, 2);
    await expect.poll(async () => (await cubeSlot(page))?.color).toBe('#0000ff');
  });
});

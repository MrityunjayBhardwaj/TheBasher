// #188 (v0.7 Phase 3) — glTF material-scalar ANIMATION boundary-pair.
//
// THE PROOF (the V56/p197 method — inject a free-floating channel, observe the
// EVALUATED render): import cube-draco → inject a `materials.0.base.metalness`
// KeyframeChannelNumber targeting the cube's GltfChild dagId DIRECTLY (no
// AnimationLayer — the glTF direct-channel road, V57) → scrub the playhead → the
// RENDERED clone's metalness (read back through `__basher_gltf_meshes`, the same
// live-three.js seam S3/S4 use) RAMPS with time. A KeyframeChannelColor on
// `materials.0.base.color` likewise drives the rendered colour.
//
// This is side A == "the channel actually animates the rendered material". The
// resolver side (overlayChannels) is unit-locked (overlayChannels.test.ts); here we
// observe the RENDER follows it per-frame — the H40 displayed≠rendered guard for the
// new material band. If the renderer read raw params.materials instead of the
// channel-overlaid value, metalness would freeze at its captured base.

import { test, expect } from './_fixtures';

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
  __basher_gltf_meshes?: () => {
    name: string;
    color: string | null;
    metalness: number | null;
  }[];
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(
      await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()),
    );
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'matanim');
  });
}

function cubeChildId(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const c = Object.values(w.__basher_dag.getState().state.nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
    );
    return c?.id ?? null;
  });
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time.getState().setTime(s);
  }, seconds);
}

const cubeSlot = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const m = (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find(
      (s) => s.name === 'cube',
    );
    return m ? { color: m.color, metalness: m.metalness } : null;
  });

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
  await expect.poll(async () => (await cubeSlot(page))?.metalness).not.toBeNull();
}

test.describe('#188 — glTF material-scalar animation (H40 boundary-pair)', () => {
  test('a free-floating metalness channel RAMPS the rendered clone metalness (0→1 over t∈[0,1])', async ({
    page,
  }) => {
    await ready(page);
    const childId = await cubeChildId(page);

    // Free-floating channel — target the GltfChild dagId DIRECTLY, no layer (V57).
    await page.evaluate((id) => {
      (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
        {
          type: 'addNode',
          nodeId: 'p188_metal',
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
        'p188-seed-metalness-channel',
      );
    }, childId);

    // Side A — the RENDERED clone metalness tracks the channel at each playhead.
    await setTime(page, 0);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(0, 2);
    await setTime(page, 1);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(1, 2);
    // The midpoint proves it TRACKS (a static read would never land at 0.5).
    await setTime(page, 0.5);
    await expect.poll(async () => (await cubeSlot(page))?.metalness).toBeCloseTo(0.5, 2);
  });

  test('a free-floating base.color channel drives the rendered clone colour', async ({ page }) => {
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
            paramPath: 'materials.0.base.color',
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

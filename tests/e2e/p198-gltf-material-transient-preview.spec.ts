// #198 (v0.7 Phase 4, item 4) — glTF material TRANSIENT preview boundary-pair.
//
// THE GAP: an Auto-Key-OFF held edit (a transient) on an ANIMATED glTF material
// field showed in the inspector (read-side, resolveEvaluatedParam) but NOT in the
// viewport — the per-frame material loop applied only the CHANNEL value, so the
// rendered surface "snapped back" to the curve while the field showed the held
// value (the H40 displayed≠rendered divergence #149 fixed for native materials).
//
// THE PROOF (the #149 method, glTF edition): import cube-draco → inject a
// `materials.0.base.metalness` channel (0→1) → pause mid-curve (t=0.5 ⇒ channel
// 0.5) → set a TRANSIENT of 0.9 on that field → the RENDERED clone metalness
// (read back through __basher_gltf_meshes, side A) reads 0.9 (transient > channel),
// not 0.5. Clearing the transient snaps the render back to the channel's 0.5.
// Reverting the overlayTransients call in the material useFrame freezes the render
// at 0.5 → this test fails (the falsifiable regression gate).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { id: string; type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void; pause: () => void } };
  __basher_transient: {
    getState: () => { set: (n: string, p: string, v: unknown) => void; clearAll: () => void };
  };
  __basher_ingestGltfFolder: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
  __basher_gltf_meshes?: () => { name: string; metalness: number | null }[];
}

async function ingestCube(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const bytes = new Uint8Array(await fetch('/assets/cube-draco.glb').then((r) => r.arrayBuffer()));
    await w.__basher_ingestGltfFolder([{ relativePath: 'cube-draco.glb', bytes }], 'mat-transient');
  });
}

function cubeChildId(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (
      Object.values(w.__basher_dag.getState().state.nodes).find(
        (n) => n.type === 'GltfChild' && n.params.childName === 'cube',
      )?.id ?? null
    );
  });
}

const cubeMetalness = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : []).find((s) => s.name === 'cube')
      ?.metalness;
  });

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    const t = (window as unknown as BasherWindow).__basher_time.getState();
    t.pause();
    t.setTime(s);
  }, seconds);
}

test('#198 — an Auto-Key-OFF transient on an animated glTF material field previews on the rendered clone', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      typeof (window as unknown as BasherWindow).__basher_ingestGltfFolder === 'function' &&
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_time &&
      !!(window as unknown as BasherWindow).__basher_transient,
  );
  await ingestCube(page);
  await expect.poll(() => cubeChildId(page)).not.toBeNull();
  await expect.poll(async () => await cubeMetalness(page)).not.toBeUndefined();
  const childId = (await cubeChildId(page))!;

  // A free-floating metalness channel (the transient is only held for ANIMATED
  // fields, so a channel must exist first) — target the GltfChild directly (V57).
  await page.evaluate((id) => {
    (window as unknown as BasherWindow).__basher_dag.getState().dispatch(
      {
        type: 'addNode',
        nodeId: 'p198t_metal',
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
      'p198-transient-seed-channel',
    );
  }, childId);

  // Paused mid-curve: the rendered metalness tracks the channel (0.5).
  await setTime(page, 0.5);
  await expect.poll(async () => await cubeMetalness(page)).toBeCloseTo(0.5, 2);

  // A held edit (Auto-Key OFF) of 0.9 — the rendered clone must PREVIEW it now
  // (transient > channel), not stay at the curve's 0.5.
  await page.evaluate(
    ({ id }) => {
      (window as unknown as BasherWindow).__basher_transient
        .getState()
        .set(id, 'materials.0.base.metalness', 0.9);
    },
    { id: childId },
  );
  await expect.poll(async () => await cubeMetalness(page)).toBeCloseTo(0.9, 2);

  // Clearing the transient snaps the render back to the channel value (0.5).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_transient.getState().clearAll();
  });
  await expect.poll(async () => await cubeMetalness(page)).toBeCloseTo(0.5, 2);
});

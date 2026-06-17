// p197 — a native primitive animated by a FREE-FLOATING direct channel (no
// AnimationLayer wrapper) renders the animation in the live viewport.
//
// v0.7 unification (#197): native meshes used to animate ONLY via an
// AnimationLayer scene-node wrapper (p153). This slice adds the camera/glTF
// "direct channel" road for native meshes — a KeyframeChannel targeting the
// mesh dagId directly, overlaid at render time by DirectChannelsR
// (SceneFromDAG) via the shared `overlayChannels` primitive. NO layer node, NO
// scene.children rewire: the box stays the scene child, and its rendered scale
// tracks the channel as the playhead scrubs.
//
// THE observation (Side A only this slice): the REAL rendered three.js object's
// world scale (__basher_mesh_world_scale) at ≥2 playhead times, animating
// [1,1,1]→[3,3,3] linearly. The read-side resolver parity (Side B / the H40
// boundary-pair) lands in the read-side slice; here we prove the viewport
// overlays a direct channel at all.
//
// REF: docs/UNIFICATION-DESIGN.md §3.1; issue #197; SceneFromDAG DirectChannelsR;
//      overlayChannels.ts; nodeChannels.ts. Sibling of p153 (the layer path) and
//      p190 (the camera direct-channel path).

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void; seconds: number } };
  __basher_mesh_world_scale?: (nodeId: string) => [number, number, number] | null;
}

async function setTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
  }, seconds);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_mesh_world_scale);
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box') !== null,
  );

  // Inject a SINGLE free-floating channel targeting n_box.scale — NO layer, NO
  // scene.children rewire. The box stays wired to the scene directly; only this
  // channel exists. DirectChannelsR must overlay it onto the rendered box.
  await page.evaluate(() => {
    const dag = (window as unknown as BasherWindow).__basher_dag!.getState();
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p197_ch',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'scale',
            target: 'n_box',
            paramPath: 'scale',
            keyframes: [
              { time: 0, value: [1, 1, 1], easing: 'linear' },
              { time: 2, value: [3, 3, 3], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'p197-seed-direct-channel',
    );
  });
});

test.describe('#197 — native primitive animated by a direct channel (no AnimationLayer)', () => {
  test('the rendered box scale tracks the direct channel as the playhead scrubs', async ({
    page,
  }) => {
    // Linear lerp of [1,1,1]→[3,3,3] over t∈[0,2]: scale(t) = 1 + t.
    // The scene child is the BOX itself (no layer), so the rendered group is
    // named 'n_box' and the probe descends to its mesh.
    const probe = async (seconds: number, expected: number) => {
      await setTime(page, seconds);
      await page.waitForFunction(
        ({ exp }) => {
          const r = (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box');
          return r !== null && Math.abs(r[0] - exp) < 1e-3;
        },
        { exp: expected },
      );
      const r = await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box'),
      );
      expect(r, `rendered@${seconds}`).not.toBeNull();
      // The REAL rendered object IS at the animated scale (observation, not inferred).
      for (let i = 0; i < 3; i++) expect(r![i]).toBeCloseTo(expected, 3);
      return r!;
    };

    const at05 = await probe(0.5, 1.5);
    const at15 = await probe(1.5, 2.5);

    // The rendered scale TRACKS the channel — the two times differ and increase.
    expect(at05[0]).not.toBeCloseTo(at15[0], 2);
    expect(at15[0]).toBeGreaterThan(at05[0]);
  });
});

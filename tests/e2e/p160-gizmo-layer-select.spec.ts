// #160 — gizmo drag on a KEYFRAMED object whose layer is selected.
//
// Regression for the H40 grab-side asymmetry: keyframing wraps the box in an
// AnimationLayer; a viewport click selects the LAYER (the scene child). Before
// #160, dragging then called routeAnimatedGrab(layerId,…), which saw the layer
// as un-animated → set no transient → "the gizmo moves, not the object."
//
// This drives the REAL inspector diamond (first-key → dynamic layer wrap) then
// the REAL gizmo seam (__basher_gizmo_grab → onObjectChange → routeAnimatedGrab)
// with the LAYER selected, and observes the RENDERED three.js object (side A).
import { test, expect } from '@playwright/test';

type Vec3 = [number, number, number];
interface W {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: {
    getState: () => {
      clearAll: () => void;
      get: (id: string, p: string) => { value: unknown } | undefined;
    };
  };
  __basher_gizmo_grab?: (mode: 'translate' | 'rotate' | 'scale', t: Vec3) => void;
  __basher_mesh_world_position?: (id: string) => Vec3 | null;
}

async function keyFirstFrameThenSelectLayer(
  page: import('@playwright/test').Page,
  autoKey: boolean,
) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag && w.__basher_selection && w.__basher_transient && w.__basher_time,
    );
  });
  // Frame 0, Auto-Key OFF to author the first key via the diamond (Auto-Key
  // state for the DRAG is set later, after selecting the layer).
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__basher_transient!.getState().clearAll();
    w.__basher_time!.getState().pause();
    w.__basher_time!.getState().setTime(0);
    w.__basher_selection!.getState().select('n_box');
    const ak = w.__basher_autokey!.getState();
    if (ak.enabled) ak.toggle();
  });
  await expect(page.getByTestId('inspector')).toBeVisible();
  await page.getByTestId('inspector-section-toggle-transform').click();
  await page.getByTestId('inspector-diamond-n_box-position').click();

  const layerId = await page.evaluate(() => {
    const w = window as unknown as W;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return Object.entries(nodes).find(([, n]) => n.type === 'AnimationLayer')?.[0] ?? null;
  });
  expect(layerId, 'first key should wrap n_box in an AnimationLayer').not.toBeNull();

  // Scrub to a NON-key frame, SELECT THE LAYER (what a real viewport click does
  // on a keyframed cube), and set the Auto-Key state for the drag.
  await page.evaluate(
    ([lid, wantAk]) => {
      const w = window as unknown as W;
      w.__basher_time!.getState().setTime(0.5);
      w.__basher_selection!.getState().select(lid as string);
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled !== (wantAk as boolean)) ak.toggle();
    },
    [layerId, autoKey] as const,
  );
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __basher_mesh_world_position?: unknown })
        .__basher_mesh_world_position === 'function',
  );
  await page.waitForTimeout(150);
  return layerId!;
}

test.describe('#160 gizmo drag with the AnimationLayer selected (H40 grab-side)', () => {
  test('Auto-Key OFF: drag HOLDS as a transient → object moves to x=9', async ({ page }) => {
    const layerId = await keyFirstFrameThenSelectLayer(page, false);

    await page.evaluate(() =>
      (window as unknown as W).__basher_gizmo_grab!('translate', [9, 0, 0]),
    );
    await page.waitForFunction(() => {
      const w = window as unknown as W;
      const p = w.__basher_mesh_world_position?.(
        Object.entries(w.__basher_dag!.getState().state.nodes).find(
          ([, n]) => n.type === 'AnimationLayer',
        )?.[0] ?? '',
      );
      return p != null && Math.abs(p[0] - 9) < 1e-2;
    });

    const { rendered, transient } = await page.evaluate((lid) => {
      const w = window as unknown as W;
      return {
        rendered: w.__basher_mesh_world_position!(lid),
        // the transient lands on the TARGET (n_box), not the layer (#160).
        transient: w.__basher_transient!.getState().get('n_box', 'position')?.value ?? null,
      };
    }, layerId);
    expect(rendered![0]).toBeCloseTo(9, 1); // object MOVED (the bug = frozen at 0)
    expect((transient as number[])[0]).toBe(9); // held on the target
  });

  test('Auto-Key ON: drag KEYS the target at the non-key frame → object moves to x=9', async ({
    page,
  }) => {
    const layerId = await keyFirstFrameThenSelectLayer(page, true);

    await page.evaluate(() =>
      (window as unknown as W).__basher_gizmo_grab!('translate', [9, 0, 0]),
    );
    await page.waitForTimeout(200);

    const { rendered, channelCount } = await page.evaluate((lid) => {
      const w = window as unknown as W;
      const nodes = w.__basher_dag!.getState().state.nodes;
      // count keyframes on the n_box position channel — ON should have added one.
      let kf = 0;
      for (const n of Object.values(nodes) as {
        type: string;
        params?: { target?: string; paramPath?: string; keyframes?: unknown[] };
      }[]) {
        if (
          n.type.startsWith('KeyframeChannel') &&
          n.params?.target === 'n_box' &&
          n.params?.paramPath === 'position'
        ) {
          kf = Array.isArray(n.params.keyframes) ? n.params.keyframes.length : 0;
        }
      }
      return { rendered: w.__basher_mesh_world_position!(lid), channelCount: kf };
    }, layerId);
    expect(rendered![0]).toBeCloseTo(9, 1); // object MOVED
    expect(channelCount).toBeGreaterThanOrEqual(2); // first key + the dragged key
  });
});

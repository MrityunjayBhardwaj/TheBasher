// #149 Wave D — a frame change discards the transient (D-149-2). Edit paused,
// then scrub one frame: the field + the rendered value revert to the curve, and
// no transient remains. A sub-frame seconds change (same frame INT) does NOT
// clear (the jitter guard, observed end-to-end).

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: {
    getState: () => {
      set: (n: string, p: string, v: unknown) => void;
      has: (n: string, p: string) => boolean;
      clearAll: () => void;
    };
  };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
}

async function seedAnimatedCube(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_transient);
  });
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const api = w.__basher_dag!.getState();
    const dispatch = (op: unknown) => api.dispatch(op);
    const nodes = () => w.__basher_dag!.getState().state.nodes;
    const findType = (t: string) => Object.entries(nodes()).find(([, n]) => n.type === t)?.[0];
    const sceneId = findType('Scene');
    if (!sceneId) throw new Error('no Scene');
    const boxId = 'n_box';
    dispatch({
      type: 'addNode',
      nodeId: 'seed_layer',
      nodeType: 'AnimationLayer',
      params: { name: 'SeedLayer', mute: false, solo: false, weight: 1, boneMask: [] },
    });
    dispatch({
      type: 'disconnect',
      from: { node: boxId, socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: 'seed_layer', socket: 'out' },
      to: { node: sceneId, socket: 'children' },
    });
    dispatch({
      type: 'connect',
      from: { node: boxId, socket: 'out' },
      to: { node: 'seed_layer', socket: 'target' },
    });
    dispatch({
      type: 'addNode',
      nodeId: 'seed_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'seed_pos',
        target: boxId,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [4, 0, 0], easing: 'linear' },
        ],
      },
    });
    dispatch({
      type: 'connect',
      from: { node: 'seed_pos_ch', socket: 'out' },
      to: { node: 'seed_layer', socket: 'animation' },
    });
  });
}

test.describe('#149 clear-on-scrub (D-149-2)', () => {
  test('frame change discards the transient → field + render revert to the curve', async ({
    page,
  }) => {
    await page.goto('/');
    await seedAnimatedCube(page);
    // Pause at t=1 (curve x=2), select, Auto-Key OFF, edit x→9 via the inspector.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle();
    });
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.getByTestId('inspector-section-toggle-transform').click();
    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await posX.fill('9');
    await posX.press('Tab');

    // Held: transient present + rendered x == 9.
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const p = w.__basher_mesh_world_position?.('seed_layer');
      return p != null && Math.abs(p[0] - 9) < 1e-3;
    });
    expect(
      await page.evaluate(() =>
        (window as unknown as BasherWindow).__basher_transient!.getState().has('n_box', 'position'),
      ),
    ).toBe(true);

    // Scrub one frame forward (t=1 → t=1.5, frame 60 → 90 — crosses a boundary).
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.5);
    });

    // The transient is discarded AND the rendered value reverts to the curve
    // (x=3 at t=1.5 on the [0,0,0]@0 → [4,0,0]@2 line).
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const p = w.__basher_mesh_world_position?.('seed_layer');
      return p != null && Math.abs(p[0] - 3) < 1e-2;
    });
    const cleared = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return {
        has: w.__basher_transient!.getState().has('n_box', 'position'),
        renderedX: w.__basher_mesh_world_position!('seed_layer')?.[0] ?? null,
      };
    });
    console.log(`[p149 D] after-scrub has=${cleared.has} renderedX=${cleared.renderedX}`);
    expect(cleared.has).toBe(false); // transient discarded on frame change
    expect(cleared.renderedX).toBeCloseTo(3, 2); // reverted to the curve value
  });

  test('sub-frame seconds change (same frame INT) does NOT clear the transient', async ({
    page,
  }) => {
    await page.goto('/');
    await seedAnimatedCube(page);
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1); // frame 60
      w.__basher_transient!.getState().set('n_box', 'position', [9, 0, 0]);
    });
    // 1.0 → 1.004s: round(1.004*60)=60, still frame 60 → must NOT clear.
    await page.evaluate(() => {
      (window as unknown as BasherWindow).__basher_time!.getState().setTime(1.004);
    });
    const stillHeld = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_transient!.getState().has('n_box', 'position'),
    );
    expect(stillHeld).toBe(true);
  });
});

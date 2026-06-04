// #149 Wave C — the H40 boundary-pair: PAUSED, the REAL rendered three.js
// object (side A) == the read resolver (side B) == the typed transient, for a
// TRANSFORM param (C3) AND a NON-TRANSFORM param (C4).
//
// This is the de-risk milestone of the phase. The hard risk is render≠read
// drift; the only way to falsify it is to observe BOTH sides against the REAL
// three.js object — not the resolver alone (the P7 E2 omission this exists to
// avoid). Side A reads the live scene via __basher_mesh_world_position /
// __basher_mesh_material; side B calls the resolver via __basher_evaluated_*.

import { expect, test } from './_fixtures';

interface Vec3Tuple {
  0: number;
  1: number;
  2: number;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }>; outputs: { render?: { node: string } } };
      dispatch: (op: unknown) => void;
    };
  };
  __basher_time?: {
    getState: () => {
      pause: () => void;
      setTime: (s: number) => void;
      seconds: number;
      playing: boolean;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_autokey?: { getState: () => { enabled: boolean; toggle: () => void } };
  __basher_transient?: {
    getState: () => {
      set: (n: string, p: string, v: unknown) => void;
      get: (n: string, p: string) => { value: unknown } | undefined;
      clearAll: () => void;
    };
  };
  __basher_evaluate?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown };
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: number[]; rotation: number[] | null; scale: number[] | null } | null;
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value: unknown } | null;
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_mesh_material?: (nodeId: string) => { color: string | null } | null;
  __basher_gizmo_grab?: (mode: 'translate' | 'rotate' | 'scale', target: Vec3Tuple) => void;
}

const ctxAt = (s: number) => ({ time: { frame: Math.round(s * 60), seconds: s, normalized: 0 } });

/** Seed n_box wrapped in an AnimationLayer with a channel on `paramPath`.
 *  Returns { layerId } — the wrapping group's name in the scene. */
async function seedWrappedAnimatedBox(
  page: import('@playwright/test').Page,
  channel: { nodeType: string; paramPath: string; keyframes: { time: number; value: unknown }[] },
) {
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_transient);
  });
  const ids = await page.evaluate((chan) => {
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
      nodeId: 'seed_ch',
      nodeType: chan.nodeType,
      params: {
        name: 'seed_ch',
        target: boxId,
        paramPath: chan.paramPath,
        keyframes: chan.keyframes,
      },
    });
    dispatch({
      type: 'connect',
      from: { node: 'seed_ch', socket: 'out' },
      to: { node: 'seed_layer', socket: 'animation' },
    });
    const n = nodes();
    return { layerId: Object.entries(n).find(([, x]) => x.type === 'AnimationLayer')?.[0] ?? null };
  }, channel);
  return ids;
}

test.describe('#149 transient boundary-pair (H40, PAUSED)', () => {
  test('C3 transform: rendered position == resolver == typed transient (PAUSED, OFF)', async ({
    page,
  }) => {
    await page.goto('/');
    await seedWrappedAnimatedBox(page, {
      nodeType: 'KeyframeChannelVec3',
      paramPath: 'position',
      keyframes: [
        { time: 0, value: [0, 0, 0] },
        { time: 2, value: [4, 0, 0] },
      ],
    });
    // Pause at a non-key time, select the box, Auto-Key OFF.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle();
    });
    // Open the Transform section and edit position.x via the REAL inspector edit
    // path (VectorComponent → routeAnimatedGrab → transient, since paused +
    // animated + Auto-Key OFF). At t=1 the curve x=2, so editing x→9 holds [9,*,*].
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.getByTestId('inspector-section-toggle-transform').click();
    const posX = page.getByTestId('inspector-vec-n_box-position-x');
    await expect(posX).toBeVisible();
    await posX.fill('9');
    await posX.press('Tab');
    // Wait for the render overlay (useFrame) to apply the held edit.
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const p = w.__basher_mesh_world_position?.('seed_layer');
      return p != null && Math.abs(p[0] - 9) < 1e-3;
    });

    const { sideA, sideB, transient } = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ctx = { time: { frame: 60, seconds: 1, normalized: 0.1 } };
      return {
        sideA: w.__basher_mesh_world_position!('seed_layer'),
        sideB: w.__basher_evaluated_transform!('n_box', ctx)?.position ?? null,
        transient: w.__basher_transient!.getState().get('n_box', 'position')?.value ?? null,
      };
    });
    console.log(
      `[p149 C3] sideA=${JSON.stringify(sideA)} sideB=${JSON.stringify(sideB)} transient=${JSON.stringify(transient)}`,
    );

    // H40 boundary-pair: REAL rendered object == resolver == typed transient.
    expect(sideA![0]).toBeCloseTo(9, 3);
    expect(sideB![0]).toBeCloseTo(9, 3);
    expect((transient as number[])[0]).toBe(9);
  });

  test('C4 non-transform: rendered material == resolver, with AND without a transient (PAUSED)', async ({
    page,
  }) => {
    await page.goto('/');
    // Animate material.color black→white; paused at t=1 the curve samples grey.
    await seedWrappedAnimatedBox(page, {
      nodeType: 'KeyframeChannelColor',
      paramPath: 'material.color',
      keyframes: [
        { time: 0, value: '#000000' },
        { time: 2, value: '#ffffff' },
      ],
    });
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().clearAll();
      w.__basher_time!.getState().pause();
      w.__basher_time!.getState().setTime(1);
      w.__basher_selection!.getState().select('n_box');
      const ak = w.__basher_autokey!.getState();
      if (ak.enabled) ak.toggle();
    });

    // Wait for the scene-walk material seam (registered by MeshScaleProbe) and
    // for the channel-driven material to render the curve value (non-default).
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return (
        typeof w.__basher_mesh_material === 'function' &&
        w.__basher_mesh_material('seed_layer') != null
      );
    });

    // (a) NO transient — the CHANNEL path: rendered material (side A) ==
    //     resolveEvaluatedParam channel .sample() (side B). This is the H40
    //     form-1 gate at the e2e level (render samples the value, read samples
    //     the value — no re-interpolation drift).
    const noTransient = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ctx = { time: { frame: 60, seconds: 1, normalized: 0.1 } };
      return {
        sideA: w.__basher_mesh_material!('seed_layer')?.color ?? null,
        sideB: w.__basher_evaluated_param!('n_box', 'material.color', ctx)?.value ?? null,
      };
    });
    console.log(`[p149 C4 channel] sideA=${noTransient.sideA} sideB=${noTransient.sideB}`);
    expect(noTransient.sideA).not.toBeNull();
    expect(String(noTransient.sideB).toLowerCase()).toBe(String(noTransient.sideA).toLowerCase());

    // (b) WITH a transient — set a held edit, the render + read both overlay it.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_transient!.getState().set('n_box', 'material.color', '#ff0000');
    });
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const c = w.__basher_mesh_material!('seed_layer')?.color ?? '';
      return c.toLowerCase() === '#ff0000';
    });
    const withTransient = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const ctx = { time: { frame: 60, seconds: 1, normalized: 0.1 } };
      return {
        sideA: w.__basher_mesh_material!('seed_layer')?.color ?? null,
        sideB: w.__basher_evaluated_param!('n_box', 'material.color', ctx)?.value ?? null,
      };
    });
    console.log(`[p149 C4 transient] sideA=${withTransient.sideA} sideB=${withTransient.sideB}`);
    expect(String(withTransient.sideA).toLowerCase()).toBe('#ff0000');
    expect(String(withTransient.sideB).toLowerCase()).toBe('#ff0000');
  });
});

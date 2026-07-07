// NLA strip on a LIGHT target (epic #283 Phase 2) — the H40 boundary-pair for a
// DirectionalLight driven by a placed Strip. A light enters the scene through the
// `lights` socket (not `children`), so it renders via LightNode → DirectChannelsLightR,
// a DIFFERENT mount than a mesh — this proves the strip enumerator + fold reach that
// mount too (render == read), not just the mesh road.
//
// Observation hooks: RENDER = __basher_light_world_positions() (the REAL three.js
// light world positions; the default scene carries a Studio rig, so this returns
// several — n_light is the one the strip drives). READ = __basher_evaluated_param
// ('n_light','position') (the resolver the inspector/agents read, keyed by node id).
// The pair: the read-resolved value is PRESENT among the rendered light positions
// (they fold through the SAME layered enumeration → cannot diverge). Falsify: mute
// the track → the driven value leaves the render, the seed returns, read → null
// (no override = use base, the resolver's contract).
//
// NOTE — matched by "render set contains read value" rather than by node id: the
// rendered three.js light object is unnamed (meshes are named by nodeId, lights are
// not), so there is no getObjectByName road for a light. A coincidental collision
// among the rig lights at the driven value is implausible and the mute-falsify pins
// it. Render-graph naming parity for lights is tracked separately.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => unknown } };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_light_world_positions?: () => [number, number, number][];
  __basher_evaluated_param?: (
    nodeId: string,
    paramPath: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { value?: unknown } | null;
}

/** Does the rendered light set contain `v` (within float tolerance)? */
const contains = (lights: [number, number, number][], v: [number, number, number]) =>
  lights.some((p) => p.every((n, i) => Math.abs(n - v[i]) < 1e-6));

async function sample(page: import('@playwright/test').Page, t: number) {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate((time) => {
    const w = window as unknown as BasherWindow;
    return {
      render: w.__basher_light_world_positions!(),
      read:
        (w.__basher_evaluated_param!('n_light', 'position', {
          time: { frame: 0, seconds: time, normalized: 0 },
        })?.value as [number, number, number] | undefined) ?? null,
    };
  }, t);
}

test('NLA — a placed Strip drives a LIGHT; render == read; mute reverts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(
    () =>
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_light_world_positions &&
      !!(window as unknown as BasherWindow).__basher_evaluated_param,
    { timeout: 20000 },
  );
  const dispatch = (op: Record<string, unknown>) =>
    page.evaluate(
      (o) => (window as unknown as BasherWindow).__basher_dag!.getState().dispatch(o),
      op,
    );
  const addNode = (id: string, type: string, params: Record<string, unknown>) =>
    dispatch({ type: 'addNode', nodeId: id, nodeType: type, params, inputs: {} });

  // A 2s position ramp on n_light, placed as a strip on a track.
  await addNode('nla_act_l', 'Action', {
    name: 'lightlift',
    channels: [
      {
        valueType: 'vec3',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [0, 5, 0], easing: 'linear' },
        ],
      },
    ],
  });
  await addNode('nla_s_l', 'Strip', {
    name: 'sl',
    action: 'nla_act_l',
    target: 'n_light',
    start: 0,
  });
  await addNode('nla_trk_l', 'Track', { name: 'LightTrk', strips: ['nla_s_l'], order: 0 });

  // render == read across the ramp, and the light is genuinely driven.
  for (const [t, expected] of [
    [0, [0, 0, 0]],
    [0.5, [0, 1.25, 0]],
    [1, [0, 2.5, 0]],
    [2, [0, 5, 0]],
  ] as const) {
    const { render, read } = await sample(page, t);
    expect(read).toEqual(expected); // the resolver drives the light
    expect(contains(render, expected as [number, number, number])).toBe(true); // render == read
  }

  // Falsify — mute the track. The driven value leaves the render, the seed [5,5,3]
  // returns, and the resolver reports null (no override → use base).
  await dispatch({ type: 'setParam', nodeId: 'nla_trk_l', paramPath: 'mute', value: true });
  const muted = await sample(page, 1);
  expect(muted.read).toBeNull();
  expect(contains(muted.render, [5, 5, 3])).toBe(true); // reverted to seed
  expect(contains(muted.render, [0, 2.5, 0])).toBe(false); // driven value gone

  expect(errors).toEqual([]);
});

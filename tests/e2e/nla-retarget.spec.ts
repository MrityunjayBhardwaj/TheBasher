// NLA retarget (epic #283 Phase 3, inc 3A) — the I-1 headline gate: the SAME
// immutable Action drives TWO different scene objects via two Strips with different
// `target`s; render (real three.js world position) == read (resolveEvaluatedTransform)
// on BOTH independently; muting one strip reverts only its object (no cross-contamination).
// Retarget is structural at 3df643f (per-target enumeration + per-Strip target binding);
// this spec proves it end-to-end. No product code — a capability made explicit.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => unknown;
      state: { nodes: Record<string, { type: string }> };
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] } | null;
}

const r3 = (p: readonly number[] | null | undefined) =>
  p ? p.map((n) => Math.round(n * 1000) / 1000) : null;

/** Render (real object world pos) and read (resolver) for `nodeId` at time T, rounded. */
async function renderVsRead(page: import('@playwright/test').Page, nodeId: string, t: number) {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(
    ({ id, time }) => {
      const w = window as unknown as BasherWindow;
      return {
        render: w.__basher_mesh_world_position!(id),
        read:
          w.__basher_evaluated_transform!(id, {
            time: { frame: 0, seconds: time, normalized: 0 },
          })?.position ?? null,
      };
    },
    { id: nodeId, time: t },
  );
}

test('NLA 3A — one Action drives two objects, render==read independently, mute-one-reverts-only-it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(
    () =>
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_mesh_world_position &&
      !!(window as unknown as BasherWindow).__basher_evaluated_transform,
    { timeout: 20000 },
  );

  const dispatch = (op: Record<string, unknown>) =>
    page.evaluate(
      (o) => (window as unknown as BasherWindow).__basher_dag!.getState().dispatch(o),
      op,
    );
  const addNode = (id: string, type: string, params: Record<string, unknown>) =>
    dispatch({ type: 'addNode', nodeId: id, nodeType: type, params, inputs: {} });

  // Wire a second box to the Scene (the p151-apply-transform pattern).
  const sceneId = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return Object.entries(nodes).find(([, n]) => n.type === 'Scene')?.[0] ?? null;
  });
  expect(sceneId).not.toBeNull();
  await dispatch({
    type: 'addNode',
    nodeId: 'n_box2',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
    inputs: {},
  });
  await dispatch({
    type: 'connect',
    from: { node: 'n_box2', socket: 'out' },
    to: { node: sceneId, socket: 'children' },
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box2') !== null,
    { timeout: 10000 },
  );

  // ONE immutable Action (a 2s vec3 position ramp), placed as TWO Strips on two targets.
  await addNode('nla_act', 'Action', {
    name: 'walk',
    channels: [
      {
        valueType: 'vec3',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [2, 1, 0], easing: 'linear' },
        ],
      },
    ],
  });
  await addNode('nla_s1', 'Strip', { name: 's1', action: 'nla_act', target: 'n_box', start: 0 });
  await addNode('nla_s2', 'Strip', { name: 's2', action: 'nla_act', target: 'n_box2', start: 0 });
  await addNode('nla_trk', 'Track', { name: 'Base', strips: ['nla_s1', 'nla_s2'], order: 0 });

  // Both objects: render == read at every sampled time (H40 on each, independently).
  for (const nodeId of ['n_box', 'n_box2']) {
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      const { render, read } = await renderVsRead(page, nodeId, t);
      expect(r3(read)).toEqual(r3(render));
      expect(render).not.toBeNull();
    }
  }
  // The SAME Action drives both: at t=1 both hit the ramp midpoint [1, 0.5, 0].
  expect(r3((await renderVsRead(page, 'n_box', 1)).render)).toEqual([1, 0.5, 0]);
  expect(r3((await renderVsRead(page, 'n_box2', 1)).render)).toEqual([1, 0.5, 0]);

  // Falsify (independence): mute s2 → n_box2 reverts, n_box UNAFFECTED.
  await dispatch({ type: 'setParam', nodeId: 'nla_s2', paramPath: 'muted', value: true });
  {
    const b1 = await renderVsRead(page, 'n_box', 1);
    const b2 = await renderVsRead(page, 'n_box2', 1);
    expect(r3(b1.render)).toEqual([1, 0.5, 0]);
    expect(r3(b1.read)).toEqual([1, 0.5, 0]);
    expect(r3(b2.render)).toEqual([0, 0, 0]);
    expect(r3(b2.read)).toEqual([0, 0, 0]);
  }
  // Mirror: unmute s2, mute s1 → n_box reverts, n_box2 UNAFFECTED.
  await dispatch({ type: 'setParam', nodeId: 'nla_s2', paramPath: 'muted', value: false });
  await dispatch({ type: 'setParam', nodeId: 'nla_s1', paramPath: 'muted', value: true });
  {
    const b1 = await renderVsRead(page, 'n_box', 1);
    const b2 = await renderVsRead(page, 'n_box2', 1);
    expect(r3(b1.render)).toEqual([0, 0, 0]);
    expect(r3(b1.read)).toEqual([0, 0, 0]);
    expect(r3(b2.render)).toEqual([1, 0.5, 0]);
    expect(r3(b2.read)).toEqual([1, 0.5, 0]);
  }

  expect(errors).toEqual([]);
});

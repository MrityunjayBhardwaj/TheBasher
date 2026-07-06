// NLA strip boundary-pair (epic #283 Phase 2, Slice E) — the H40 gate: the placed
// Strip's RENDER (the real three.js world position) == its READ (resolveEvaluated-
// Transform, what the gizmo/inspector see) at multiple times, for a single strip AND
// a stacked two-strip fold. Falsify: mute the track → render == read == base.
// Render and read fold through the SAME layered enumeration → they cannot diverge.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => { dispatch: (op: unknown) => unknown };
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

/** Render (real object world pos) and read (resolver) at time T, both rounded. */
async function renderVsRead(page: import('@playwright/test').Page, t: number) {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate((time) => {
    const w = window as unknown as BasherWindow;
    const render = w.__basher_mesh_world_position!('n_box');
    const read =
      w.__basher_evaluated_transform!('n_box', {
        time: { frame: 0, seconds: time, normalized: 0 },
      })?.position ?? null;
    return { render, read };
  }, t);
}

test('NLA Slice E — render == read for a placed Strip (single + stacked), mute reverts', async ({
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
  await addNode('nla_trk', 'Track', { name: 'Base', strips: ['nla_s1'], order: 0 });

  // Single strip — render == read at every sampled time (and the value moves).
  for (const t of [0, 0.5, 1, 1.5, 2]) {
    const { render, read } = await renderVsRead(page, t);
    expect(r3(read)).toEqual(r3(render)); // H40 — read tracks render
    expect(render).not.toBeNull();
  }
  // and it is genuinely animated (t=1 is the ramp midpoint [1, 0.5, 0]).
  expect(r3((await renderVsRead(page, 1)).render)).toEqual([1, 0.5, 0]);

  // Stacked — a second strip (start=3) on the same track; the fold is order-stable
  // and render still == read (both sides fold identically).
  await addNode('nla_s2', 'Strip', { name: 's2', action: 'nla_act', target: 'n_box', start: 3 });
  await dispatch({
    type: 'setParam',
    nodeId: 'nla_trk',
    paramPath: 'strips',
    value: ['nla_s1', 'nla_s2'],
  });
  for (const t of [1, 4]) {
    const { render, read } = await renderVsRead(page, t);
    expect(r3(read)).toEqual(r3(render)); // H40 holds under the stacked fold
  }

  // Falsify — mute the track → render == read == base at every time.
  await dispatch({ type: 'setParam', nodeId: 'nla_trk', paramPath: 'mute', value: true });
  const muted = await renderVsRead(page, 1);
  expect(r3(muted.render)).toEqual([0, 0, 0]);
  expect(r3(muted.read)).toEqual([0, 0, 0]);

  expect(errors).toEqual([]);
});

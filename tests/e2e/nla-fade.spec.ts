// NLA single-strip fade (epic #283 Phase 3, inc 3B) — time-varying influence at
// fold site #1 (the `overlayChannels` overlay twin): a Strip authoring blendIn=1
// fades its box in from the origin over the first second, render == read at every
// time (both `__basher_mesh_world_position` and `__basher_evaluated_transform` fold
// through `overlayChannels`). Falsify: blendIn=0 → static full influence (Phase-2
// behavior), byte-identical.
//
// Coverage scope (honest): this exercises fold site #1 only. Fold site #2
// (`resolveEvaluatedParam` :91 guard + :103 influenceAt, reached by
// `__basher_evaluated_param`) is proven by the mandatory unit cases 5+6 in
// src/app/nlaInfluence.test.ts — the position read hooks never reach it.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => unknown } };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] } | null;
}

const r3 = (p: readonly number[] | null | undefined) =>
  p ? p.map((n) => Math.round(n * 1000) / 1000) : null;

async function renderVsRead(page: import('@playwright/test').Page, t: number) {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate((time) => {
    const w = window as unknown as BasherWindow;
    return {
      render: w.__basher_mesh_world_position!('n_box'),
      read:
        w.__basher_evaluated_transform!('n_box', {
          time: { frame: 0, seconds: time, normalized: 0 },
        })?.position ?? null,
    };
  }, t);
}

test('NLA 3B — a single strip blendIn fades render==read, static when blendIn=0', async ({
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
  await addNode('nla_s1', 'Strip', {
    name: 's1',
    action: 'nla_act',
    target: 'n_box',
    start: 0,
    blendIn: 1,
  });
  await addNode('nla_trk', 'Track', { name: 'Base', strips: ['nla_s1'], order: 0 });

  // render == read at every time (both fold through overlayChannels :82).
  for (const t of [0, 0.5, 1, 2]) {
    const { render, read } = await renderVsRead(page, t);
    expect(r3(read)).toEqual(r3(render));
    expect(render).not.toBeNull();
  }
  // The fade is REAL (time-varying): at t=0.5, influence ramps to 0.5, so a Replace
  // strip over base [0,0,0] renders sample(0.5)·0.5 = [0.5,0.25,0]·0.5 = [0.25,0.125,0]
  // — a STATIC strip would render the full [0.5,0.25,0].
  expect(r3((await renderVsRead(page, 0)).render)).toEqual([0, 0, 0]); // inf=0 at range start
  expect(r3((await renderVsRead(page, 0.5)).render)).toEqual([0.25, 0.125, 0]);
  expect(r3((await renderVsRead(page, 1)).render)).toEqual([1, 0.5, 0]); // full influence

  // Falsify (byte-identity): blendIn=0 → no influenceAt attached → static full
  // influence → Phase-2 value [0.5,0.25,0] at t=0.5, render == read.
  await dispatch({ type: 'setParam', nodeId: 'nla_s1', paramPath: 'blendIn', value: 0 });
  {
    const { render, read } = await renderVsRead(page, 0.5);
    expect(r3(render)).toEqual([0.5, 0.25, 0]);
    expect(r3(read)).toEqual([0.5, 0.25, 0]);
  }

  expect(errors).toEqual([]);
});

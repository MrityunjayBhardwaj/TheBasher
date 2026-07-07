// NLA agent mutators — 4B edit (epic #283 Phase 4, inc 4B). An agent places a walk
// (4A createAction + addStrip), then EDITS it: setStripTiming shifts the placement in
// time; setStripBlend authors a blendIn crossfade (the Phase-3 TIME-VARYING influence
// seam). Each edit drives render == read (H40) through the real five-gate
// __basher_dispatchMutator path. Falsify: clearing blendIn → the static Phase-2 value.
//
// Every setup dispatch asserts res.ok === true (a silent {ok:false} would leave the DAG
// unchanged and be mis-attributed to the fold; R5).

import { test, expect } from './_fixtures';

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: { getState: () => { dispatch: (op: unknown) => unknown } };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_transform?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position?: [number, number, number] } | null;
  __basher_dispatchMutator?: (name: string, spec: unknown, intent: string) => DispatchResult;
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

test('NLA 4B — agent setStripTiming + setStripBlend edit a placed strip, render==read', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(
    () =>
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_mesh_world_position &&
      !!(window as unknown as BasherWindow).__basher_evaluated_transform &&
      !!(window as unknown as BasherWindow).__basher_dispatchMutator,
    { timeout: 20000 },
  );

  const dispatchMutator = (name: string, spec: unknown, intent: string) =>
    page.evaluate(
      ([n, s, i]) =>
        (window as unknown as BasherWindow).__basher_dispatchMutator!(n as string, s, i as string),
      [name, spec, intent] as const,
    );
  const okDispatch = async (name: string, spec: unknown, intent: string) => {
    const res = await dispatchMutator(name, spec, intent);
    expect(res.ok, `${name} rejected: ${res.reason}`).toBe(true);
  };

  // Setup (4A path): a walk Action placed on n_box in an auto-created track.
  await okDispatch(
    'mutator.nla.createAction',
    {
      name: 'walk',
      actionId: 'nla_act',
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
    },
    'author a walk',
  );
  await okDispatch(
    'mutator.nla.addStrip',
    { action: 'nla_act', target: 'n_box', stripId: 'nla_s1' },
    'place the walk',
  );

  // Timing shift: start=1 → placed range [1,3]. Before/at t=1 the strip holds its start
  // pose [0,0,0]; at t=2 the action time is 1 → [1,0.5,0]. Proves the retime (render==read).
  await okDispatch('mutator.nla.setStripTiming', { stripId: 'nla_s1', start: 1 }, 'shift +1s');
  {
    const at1 = await renderVsRead(page, 1);
    expect(r3(at1.read)).toEqual(r3(at1.render));
    expect(r3(at1.render)).toEqual([0, 0, 0]);
    const at2 = await renderVsRead(page, 2);
    expect(r3(at2.read)).toEqual(r3(at2.render));
    expect(r3(at2.render)).toEqual([1, 0.5, 0]);
  }

  // Blend fade: reset start=0, then blendIn=1 → influence ramps 0→1 over [0,1]. At t=0.5
  // the box is at sample(0.5)·inf(0.5) = [0.5,0.25,0]·0.5 = [0.25,0.125,0] — the observation
  // that proves the agent authored a TIME-VARYING influence (static would give [0.5,0.25,0]).
  await okDispatch('mutator.nla.setStripTiming', { stripId: 'nla_s1', start: 0 }, 'reset start');
  await okDispatch('mutator.nla.setStripBlend', { stripId: 'nla_s1', blendIn: 1 }, 'fade in');
  {
    const at05 = await renderVsRead(page, 0.5);
    expect(r3(at05.read)).toEqual(r3(at05.render));
    expect(r3(at05.render)).toEqual([0.25, 0.125, 0]);
    const at1 = await renderVsRead(page, 1);
    expect(r3(at1.read)).toEqual(r3(at1.render));
    expect(r3(at1.render)).toEqual([1, 0.5, 0]);
  }

  // Falsify: clear blendIn → static full influence (Phase-2) → [0.5,0.25,0] at t=0.5.
  await okDispatch('mutator.nla.setStripBlend', { stripId: 'nla_s1', blendIn: 0 }, 'clear fade');
  {
    const at05 = await renderVsRead(page, 0.5);
    expect(r3(at05.read)).toEqual(r3(at05.render));
    expect(r3(at05.render)).toEqual([0.5, 0.25, 0]);
  }

  expect(errors).toEqual([]);
});

// NLA agent mutators — 4A place (epic #283 Phase 4, inc 4A). Proves the AGENT
// authoring path end-to-end: an agent calls mutator.nla.createAction to mint a
// reusable walk Action, then mutator.nla.addStrip to place it on n_box — with NO
// trackId, so addStrip AUTO-CREATES the Track (a strip is invisible until it lands in
// a track). The placed Action then drives render == read (H40) through the real
// five-gate __basher_dispatchMutator path (validate → propose → accept), not a raw
// setParam. Falsify: muting the auto-created track reverts n_box to base.
//
// Ramp: position t0=[0,0,0] → t2=[2,1,0] (linear) → at t=1 the box is at [1,0.5,0]
// (Replace strip, static influence 1). A silent {ok:false} gate rejection would leave
// the DAG unchanged and the box unmoving (mis-attributed to the fold) — so EVERY setup
// dispatch asserts res.ok === true (R5).

import { test, expect } from './_fixtures';

interface DispatchResult {
  ok: boolean;
  reason?: string;
}

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => unknown;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
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

test('NLA 4A — agent createAction + addStrip places a walk, render==read (auto-track)', async ({
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

  // The AGENT path: __basher_dispatchMutator RETURNS the DispatchResult — assert ok on
  // every setup step (a silent {ok:false} would leave the DAG unchanged; R5).
  const dispatchMutator = (name: string, spec: unknown, intent: string) =>
    page.evaluate(
      ([n, s, i]) =>
        (window as unknown as BasherWindow).__basher_dispatchMutator!(n as string, s, i as string),
      [name, spec, intent] as const,
    );

  // 1 — mint a reusable, target-less walk Action.
  const created = await dispatchMutator(
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
    'author a walk Action',
  );
  expect(created.ok, `createAction rejected: ${created.reason}`).toBe(true);

  // 2 — place it on n_box with NO trackId → addStrip auto-creates the Track.
  const placed = await dispatchMutator(
    'mutator.nla.addStrip',
    { action: 'nla_act', target: 'n_box', stripId: 'nla_s1' },
    'place the walk on n_box',
  );
  expect(placed.ok, `addStrip rejected: ${placed.reason}`).toBe(true);

  // R3 — the strip actually landed in an auto-created track (else it is invisible).
  const track = await page.evaluate(
    () =>
      (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['nla_track_1'] ??
      null,
  );
  expect(track).not.toBeNull();
  expect(track!.type).toBe('Track');
  expect((track!.params as { strips: string[] }).strips).toContain('nla_s1');

  // render == read + intended: the placed Action drives the box along the ramp.
  const expected: Record<number, [number, number, number]> = {
    0: [0, 0, 0],
    0.5: [0.5, 0.25, 0],
    1: [1, 0.5, 0],
    1.5: [1.5, 0.75, 0],
    2: [2, 1, 0],
  };
  for (const t of [0, 0.5, 1, 1.5, 2]) {
    const { render, read } = await renderVsRead(page, t);
    expect(render, `render null at t=${t}`).not.toBeNull();
    expect(r3(read)).toEqual(r3(render)); // H40
    expect(r3(render)).toEqual(expected[t]);
  }

  // Falsify: mute the auto-created track (raw setParam — setTrackState ships in 4C) →
  // the strip drops at enumeration → n_box reverts to base [0,0,0], render == read.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_track_1',
      paramPath: 'mute',
      value: true,
    }),
  );
  {
    const { render, read } = await renderVsRead(page, 1);
    expect(r3(render)).toEqual([0, 0, 0]);
    expect(r3(read)).toEqual([0, 0, 0]);
  }

  // Un-mute → the placement returns (proves the mute, not a teardown, caused the revert).
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_track_1',
      paramPath: 'mute',
      value: false,
    }),
  );
  {
    const { render, read } = await renderVsRead(page, 1);
    expect(r3(render)).toEqual([1, 0.5, 0]);
    expect(r3(read)).toEqual([1, 0.5, 0]);
  }

  expect(errors).toEqual([]);
});

// NLA strip render (epic #283 Phase 2, Slice D) — a placed Strip DRIVES the box in
// the real viewport (render side), a second strip replays the Action at a later
// time, and muting the track reverts to base (falsify). Drives the SAME addNode ops
// a user's Add-menu / mutators would, then reads the rendered three.js world pos.
// Two overlapping Replace strips → the TOP strip wins (correct Blender NLA), so the
// strip-drive is observed on a single strip before the second (top) strip is added.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown) => unknown;
    };
  };
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (nodeId: string) => [number, number, number] | null;
}

const posAt = async (page: import('@playwright/test').Page, t: number) => {
  await page.evaluate((time) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(time);
  }, t);
  // let the render follower's useFrame apply the sampled value
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_mesh_world_position!('n_box'),
  );
};

const round = (p: [number, number, number] | null) =>
  p?.map((n) => Math.round(n * 100) / 100) ?? null;

test('NLA Slice D — a placed Strip drives the box; a second strip replays; mute reverts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(
    () =>
      !!(window as unknown as BasherWindow).__basher_dag &&
      !!(window as unknown as BasherWindow).__basher_mesh_world_position,
    { timeout: 20000 },
  );

  const addNode = (id: string, type: string, params: Record<string, unknown>) =>
    page.evaluate(
      ({ id, type, params }) =>
        (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
          type: 'addNode',
          nodeId: id,
          nodeType: type,
          params,
          inputs: {},
        }),
      { id, type, params },
    );

  // Stage 1 — ONE strip s1 (start=0) of a 2s position ramp on n_box.
  await addNode('nla_act', 'Action', {
    name: 'walk',
    channels: [
      {
        valueType: 'vec3',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 2, value: [2, 0, 0], easing: 'linear' },
        ],
      },
    ],
  });
  await addNode('nla_s1', 'Strip', { name: 's1', action: 'nla_act', target: 'n_box', start: 0 });
  await addNode('nla_trk', 'Track', { name: 'Base', strips: ['nla_s1'], order: 0 });

  const t0 = round(await posAt(page, 0)); // action t=0 → [0,0,0]
  const t1 = round(await posAt(page, 1)); // action t=1 → [1,0,0]  (strip DRIVES, moves)
  const t2 = round(await posAt(page, 2)); // action t=2 → [2,0,0]

  // Stage 2 — add a SECOND strip s2 (start=3, the top strip). At t=4 it plays the
  // Action's t=1 (a replay of the same performance at a later time) → [1,0,0]; s1
  // alone would hold [2,0,0] there, so this is unambiguously the second strip.
  await addNode('nla_s2', 'Strip', { name: 's2', action: 'nla_act', target: 'n_box', start: 3 });
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_trk',
      paramPath: 'strips',
      value: ['nla_s1', 'nla_s2'],
    }),
  );
  const replay = round(await posAt(page, 4)); // second strip replays → [1,0,0]

  // Stage 3 — falsify: mute the track → box reverts to base at every time.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
      type: 'setParam',
      nodeId: 'nla_trk',
      paramPath: 'mute',
      value: true,
    }),
  );
  const muted = round(await posAt(page, 1)); // muted → base

  expect(t0).toEqual([0, 0, 0]);
  expect(t1).toEqual([1, 0, 0]); // the strip DRIVES the box (impossible statically)
  expect(t2).toEqual([2, 0, 0]); // and moves across time
  expect(replay).toEqual([1, 0, 0]); // the second strip replays the Action at a later time
  expect(muted).toEqual([0, 0, 0]); // falsify — mute reverts to base
  expect(errors).toEqual([]);
});

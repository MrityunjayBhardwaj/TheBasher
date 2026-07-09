// NLA agent mutators — 4C track state (epic #283 Phase 4, inc 4C). An agent authors two
// constant-pose Actions, places each in its OWN track on n_box, then drives the track
// controls via mutator.nla.setTrackState: order (reorder CHANGES the fold, I-2), mute
// (drop a whole track), solo (silence non-solo tracks, global). Every state change drives
// render == read (H40) through the real five-gate __basher_dispatchMutator path.
//
// Pinned poses (Replace fold, base [0,0,0], inf 1 → last-wins = the top track's value):
//   Action A held [-4,0,0] in track tkA; Action B held [4,0,0] in track tkB.
// Every setup dispatch asserts res.ok === true (R5).

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

test('NLA 4C — agent setTrackState drives order/mute/solo, render==read', async ({ page }) => {
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
  // A held-pose Action = two keys at the same value (pure fold of a constant).
  const constAction = (actionId: string, x: number) =>
    okDispatch(
      'mutator.nla.createAction',
      {
        name: actionId,
        actionId,
        channels: [
          {
            valueType: 'vec3',
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [x, 0, 0], easing: 'linear' },
              { time: 2, value: [x, 0, 0], easing: 'linear' },
            ],
          },
        ],
      },
      'author const action',
    );
  const expectAt1 = async (expected: [number, number, number]) => {
    const { render, read } = await renderVsRead(page, 1);
    expect(r3(read)).toEqual(r3(render)); // H40
    expect(r3(render)).toEqual(expected);
  };
  const setTrack = (trackId: string, patch: Record<string, unknown>) =>
    okDispatch('mutator.nla.setTrackState', { trackId, ...patch }, 'track state');

  // Author two Actions, place each in its own auto-created track on n_box.
  await constAction('nla_actA', -4);
  await constAction('nla_actB', 4);
  await okDispatch(
    'mutator.nla.addStrip',
    { action: 'nla_actA', target: 'n_box', stripId: 'sA', trackId: 'tkA' },
    'place A',
  );
  await okDispatch(
    'mutator.nla.addStrip',
    { action: 'nla_actB', target: 'n_box', stripId: 'sB', trackId: 'tkB' },
    'place B',
  );

  // Lift B above A (Replace last-wins → the top track's pose).
  await setTrack('tkB', { order: 1 });
  await expectAt1([4, 0, 0]);

  // mute tkB → only A contributes → [-4,0,0]; un-mute → back to B on top.
  await setTrack('tkB', { mute: true });
  await expectAt1([-4, 0, 0]);
  await setTrack('tkB', { mute: false });
  await expectAt1([4, 0, 0]);

  // order (I-2): lift A above B → reorder changes the fold result → [-4,0,0]; reset.
  await setTrack('tkA', { order: 2 });
  await expectAt1([-4, 0, 0]);
  await setTrack('tkA', { order: 0 });
  await expectAt1([4, 0, 0]);

  // solo: soloing tkB silences the non-solo tkA (global) → only B → [4,0,0].
  await setTrack('tkB', { solo: true });
  await expectAt1([4, 0, 0]);
  // Now solo tkA and un-solo tkB → the global solo rule shows only A → [-4,0,0].
  await setTrack('tkA', { solo: true });
  await setTrack('tkB', { solo: false });
  await expectAt1([-4, 0, 0]);

  // Falsify: clear all track state (order 0 both, no solo, no mute) → last-wins B on top
  // (order tie → deterministic id order tkA<tkB → B top) → [4,0,0], render==read.
  await setTrack('tkA', { solo: false, order: 0 });
  await setTrack('tkB', { order: 0 });
  await expectAt1([4, 0, 0]);

  expect(errors).toEqual([]);
});

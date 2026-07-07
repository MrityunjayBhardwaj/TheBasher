// NLA crossfade (epic #283 Phase 3, inc 3C) — two overlapping strips on one target
// blend across their overlap: strip A (blendOut) fades →0 while strip B (blendIn)
// fades →1. render == read at all-A / mid-blend / all-B (BOTH fold twins carry an
// `influenceAt` simultaneously → the R1 twin-lockstep is what the equality proves).
// Falsify: clearing the blend fields → both strips lose influenceAt → static full
// influence → Phase-2 last-wins (B above A), byte-identical.
//
// Pinned design (both fades observable, base [0,0,0]):
//   A held [-4,0,0], blendOut=2, placed [0,2] → infA(t) = (2−t)/2
//   B held [ 4,0,0], blendIn=1,  placed [1,3] → infB(t) = clamp((t−1)/1, 0..1)
//   Replace fold, order A(below)→B(above): acc = acc·(1−inf) + value·inf
//     t=1   → infA=0.5, infB=0   → [-2,0,0]
//     t=1.5 → infA=0.25, infB=0.5 → [1.5,0,0]
//     t=2   → infA=0,   infB=1   → [4,0,0]

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

test('NLA 3C — overlapping strips A→0 / B→1 crossfade, render==read across the overlap', async ({
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

  // Two constant-pose Actions (held value → the crossfade is a pure fold of poses).
  const constAction = (id: string, x: number) =>
    addNode(id, 'Action', {
      name: id,
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
    });
  await constAction('nla_actA', -4);
  await constAction('nla_actB', 4);
  await addNode('nla_A', 'Strip', {
    name: 'A',
    action: 'nla_actA',
    target: 'n_box',
    start: 0,
    blendOut: 2,
  });
  await addNode('nla_B', 'Strip', {
    name: 'B',
    action: 'nla_actB',
    target: 'n_box',
    start: 1,
    blendIn: 1,
  });
  // A below (index 0) → B above (index 1): fold order is trackRank·STRIDE + index.
  await addNode('nla_trk', 'Track', { name: 'Base', strips: ['nla_A', 'nla_B'], order: 0 });

  const expected: Record<number, [number, number, number]> = {
    1: [-2, 0, 0], // A dominant, B just entering
    1.5: [1.5, 0, 0], // mid-blend — strictly between A's and B's poses
    2: [4, 0, 0], // all B
  };
  for (const t of [1, 1.5, 2]) {
    const { render, read } = await renderVsRead(page, t);
    expect(r3(read)).toEqual(r3(render)); // H40 twin-lockstep under time-varying influence
    expect(r3(render)).toEqual(expected[t]);
  }

  // Monotonicity: the A→B sweep strictly increases x across the overlap.
  const x1 = (await renderVsRead(page, 1)).render![0];
  const x15 = (await renderVsRead(page, 1.5)).render![0];
  const x2 = (await renderVsRead(page, 2)).render![0];
  expect(x1).toBeLessThan(x15);
  expect(x15).toBeLessThan(x2);

  // Falsify (byte-identity to Phase 2): clear both blends → static full influence →
  // last-wins (B above A at inf=1) → [4,0,0] with no crossfade, render == read.
  await dispatch({ type: 'setParam', nodeId: 'nla_A', paramPath: 'blendOut', value: 0 });
  await dispatch({ type: 'setParam', nodeId: 'nla_B', paramPath: 'blendIn', value: 0 });
  {
    const { render, read } = await renderVsRead(page, 1.5);
    expect(r3(render)).toEqual([4, 0, 0]);
    expect(r3(read)).toEqual([4, 0, 0]);
  }

  expect(errors).toEqual([]);
});

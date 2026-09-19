// p1165 — pressing I on a curve with handles leaves the drawn motion exactly where it was.
//
// The default box gets a position curve whose keys carry bézier handles, shaped like the ones the
// native glTF import writes for a CUBICSPLINE track. The spec reads where three.js DRAWS the box at
// five times, then presses I, which keys the value the box already has at the current time: once
// mid-segment (a new key between two handled keys) and once on an existing key (a re-key). Before
// the fix the first moved the drawn box off its path and the second threw the key's handles away;
// Blender's insert keeps the curve in both (animrig `fcurve.cc`).
//
// REF: src/agent/mutators/builders/keyframe.ts, src/nodes/keyframeInterp.ts
// (`splitSegmentForKey`); #1165.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

type V = [number, number, number];
interface W {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_three?: {
    getState: () => {
      scene: {
        getObjectByName: (n: string) =>
          | {
              updateMatrixWorld: (f: boolean) => void;
              traverse: (
                f: (o: { isMesh?: boolean; matrixWorld: { elements: number[] } }) => void,
              ) => void;
            }
          | undefined;
      };
    };
  };
}

const KEYS = [
  {
    time: 0,
    value: [1, 0, 0],
    easing: 'cubic',
    outHandle: { time: 1 / 6, value: [1, 5 / 6, -0.5] },
  },
  {
    time: 0.5,
    value: [2, 1, 0],
    easing: 'cubic',
    inHandle: { time: -1 / 6, value: [-4 / 3, 1, -1 / 3] },
    outHandle: { time: 0.5, value: [-2, 3.5, 0.5] },
  },
  { time: 2, value: [1, 0, 1], easing: 'cubic', inHandle: { time: -0.5, value: [2.5, -2, -4.5] } },
];
const PROBES = [0.1, 0.35, 0.8, 1.2, 1.7];

async function setTime(page: Page, s: number) {
  await page.evaluate((s) => (window as unknown as W).__basher_time!.getState().setTime(s), s);
}

/** Where three draws the box's mesh, once the scene has caught up with `t`. */
async function drawnAt(page: Page, t: number): Promise<V> {
  await setTime(page, t);
  let last: V | null = null;
  // Two equal consecutive reads: the frame for `t` has been drawn.
  await expect
    .poll(async () => {
      const p = await page.evaluate(() => {
        const o = (window as unknown as W)
          .__basher_three!.getState()
          .scene.getObjectByName('n_box');
        if (!o) return null;
        // The node's Group holds still; the mesh inside it carries the animated transform.
        o.updateMatrixWorld(true);
        const meshes: V[] = [];
        o.traverse((c) => {
          const m = c.matrixWorld.elements;
          if (c.isMesh) meshes.push([m[12], m[13], m[14]]);
        });
        return meshes[0] ?? null;
      });
      const same = p !== null && last !== null && p.every((v, i) => Math.abs(v - last![i]) < 1e-9);
      last = p;
      return same;
    })
    .toBe(true);
  return last!;
}

const positionKeys = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as W).__basher_dag!.getState().state.nodes['n_box_position_channel'].params
        .keyframes as { time: number }[],
  );

async function pressI(page: Page) {
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_box'),
  );
  // As p149 does: blur whatever holds focus, or the key handler's typing guard swallows the press.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('i');
}

test('#1165 — I on a handled curve, mid-segment and on a key, leaves the drawn motion unchanged', async ({
  page,
}) => {
  test.slow(); // ten drawn reads, each waiting for its frame, around two key presses
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_selection && w.__basher_three);
  });
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  await page.evaluate((keyframes) => {
    (window as unknown as W).__basher_dag!.getState().dispatch({
      type: 'addNode',
      nodeId: 'n_box_position_channel',
      nodeType: 'KeyframeChannelVec3',
      params: { name: 'position', target: 'n_box', paramPath: 'position', keyframes },
    });
  }, KEYS);
  await page.getByTestId('floating-toolbar-timeline').click();

  const before: V[] = [];
  for (const t of PROBES) before.push(await drawnAt(page, t));
  // Positive control: the curve moves the box, so an unchanged read is not a frozen scene.
  expect(Math.abs(before[0][1] - before[2][1])).toBeGreaterThan(0.1);

  for (const [at, count] of [
    [0.25, 4], // between the keys at 0 and 0.5: a new key
    [0.5, 4], // on the key at 0.5: a re-key
  ] as const) {
    await setTime(page, at);
    await drawnAt(page, at);
    await pressI(page);
    await expect.poll(async () => (await positionKeys(page)).length).toBe(count);
    for (const [i, t] of PROBES.entries()) {
      const now = await drawnAt(page, t);
      now.forEach((v, j) =>
        expect(
          Math.abs(v - before[i][j]),
          `key at ${at}: drawn at t = ${t}, axis ${j}`,
        ).toBeLessThan(1e-4),
      );
    }
  }
});

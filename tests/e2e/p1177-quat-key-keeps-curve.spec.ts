// p1177 — pressing I on a quaternion curve with handles leaves the drawn rotation where it was.
//
// The default box is put in quaternion mode and given a rotation curve whose keys carry bézier
// handles — the shape the native glTF import writes for a CUBICSPLINE rotation (#1157). The spec
// reads the rotation three.js DRAWS at five times, then presses I, which keys the rotation the box
// already has: once mid-segment (a new key between two handled keys) and once on an existing key
// (a re-key). Blender, measured in 5.1.1 on the same kind of curve, moves by 0.0° (#1177): it keys
// each of its four rotation F-curves at the raw value it evaluates to and splits each segment.
//
// Before the fix the mid-segment press moved the drawn box by up to 23°; splitting the segment but
// storing the unit rotation still moved it by 11.6°.
//
// REF: src/agent/mutators/builders/keyframe.ts, src/nodes/keyframeInterp.ts
// (`quatValueOnCurve`, `splitSegmentForKey`); #1177, #1165, #1157.

import { expect, test } from './_fixtures';
import type { Page } from '@playwright/test';

type Q = [number, number, number, number];
interface W {
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_time?: { getState: () => { pause: () => void; setTime: (s: number) => void } };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_mesh_world_quaternion?: (id: string) => Q | null;
  __basher_three?: { getState: () => { scene: unknown } };
}

const unit = (q: number[]): number[] => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return q.map((v) => v / l);
};
const axisAngle = (axis: [number, number, number], deg: number): number[] => {
  const h = (deg * Math.PI) / 360;
  const n = Math.hypot(...axis);
  const s = Math.sin(h);
  return [(axis[0] / n) * s, (axis[1] / n) * s, (axis[2] / n) * s, Math.cos(h)];
};
const handle = (q: number[], dt: number) => unit(q).map((v) => (v * dt) / 3);

/** The curve the #1177 gate measures on: 23.1° of reshape before the fix. */
const KEYS = [
  {
    time: 0,
    value: axisAngle([0, 1, 0], 0),
    easing: 'cubic',
    outHandle: { time: 0.35 / 3, value: handle([0.4, 0.9, -0.2, 0.15], 0.35) },
  },
  {
    time: 0.35,
    value: axisAngle([0, 1, 0], 85),
    easing: 'cubic',
    inHandle: { time: -0.35 / 3, value: handle([0.2, 1.1, 0.3, -0.4], -0.35) },
    outHandle: { time: 1.25 / 3, value: handle([-0.7, 0.5, 0.9, 0.2], 1.25) },
  },
  {
    time: 1.6,
    value: axisAngle([1, 0.4, 0], 190),
    easing: 'cubic',
    inHandle: { time: -1.25 / 3, value: handle([0.9, -0.3, 0.25, 0.6], -1.25) },
  },
];
const PROBES = [0.2, 0.55, 0.8, 1.1, 1.45];

const degreesApart = (a: Q, b: Q) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

async function setTime(page: Page, s: number) {
  await page.evaluate((s) => (window as unknown as W).__basher_time!.getState().setTime(s), s);
}

/** The rotation three draws the box's mesh at, once the frame for `t` has been drawn. */
async function drawnAt(page: Page, t: number): Promise<Q> {
  await setTime(page, t);
  let last: Q | null = null;
  // Two equal consecutive reads: the frame for `t` has been drawn.
  await expect
    .poll(async () => {
      const q = await page.evaluate(() =>
        (window as unknown as W).__basher_mesh_world_quaternion!('n_box'),
      );
      const same = q !== null && last !== null && q.every((v, i) => Math.abs(v - last![i]) < 1e-9);
      last = q;
      return same;
    })
    .toBe(true);
  return last!;
}

const quatKeyCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        (window as unknown as W).__basher_dag!.getState().state.nodes['n_box_quaternion_channel']
          .params.keyframes as unknown[]
      ).length,
  );

async function pressI(page: Page) {
  await page.evaluate(() =>
    (window as unknown as W).__basher_selection!.getState().select('n_box'),
  );
  // As p1165 does: blur whatever holds focus, or the key handler's typing guard swallows the press.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('i');
}

test('#1177 — I on a handled rotation curve, mid-segment and on a key, leaves the drawn rotation unchanged', async ({
  page,
}) => {
  test.slow(); // ten drawn reads, each waiting for its frame, around two key presses
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(
      w.__basher_dag &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_mesh_world_quaternion &&
      w.__basher_three?.getState().scene,
    );
  });
  await page.evaluate(() => (window as unknown as W).__basher_time!.getState().pause());
  await page.evaluate((keyframes) => {
    const d = (window as unknown as W).__basher_dag!.getState();
    d.dispatch({
      type: 'setParam',
      nodeId: 'n_box',
      paramPath: 'rotationMode',
      value: 'quaternion',
    });
    d.dispatch({
      type: 'setParam',
      nodeId: 'n_box',
      paramPath: 'quaternion',
      value: [0, 0, 0, 1],
    });
    d.dispatch({
      type: 'addNode',
      nodeId: 'n_box_quaternion_channel',
      nodeType: 'KeyframeChannelQuat',
      params: { name: 'quaternion', target: 'n_box', paramPath: 'quaternion', keyframes },
    });
  }, KEYS);
  await page.getByTestId('floating-toolbar-timeline').click();

  const before: Q[] = [];
  for (const t of PROBES) before.push(await drawnAt(page, t));
  // Positive control: the curve turns the box, so an unchanged read is not a frozen scene.
  expect(degreesApart(before[0], before[3])).toBeGreaterThan(20);

  for (const [at, count] of [
    [0.9, 4], // between the keys at 0.35 and 1.6: a new key
    [0.35, 4], // on the key at 0.35: a re-key
  ] as const) {
    await setTime(page, at);
    await drawnAt(page, at);
    await pressI(page);
    await expect.poll(() => quatKeyCount(page)).toBe(count);
    for (const [i, t] of PROBES.entries()) {
      const now = await drawnAt(page, t);
      expect(
        degreesApart(now, before[i]),
        `key at ${at}: the drawn rotation at t = ${t}`,
      ).toBeLessThan(0.01);
    }
  }
});

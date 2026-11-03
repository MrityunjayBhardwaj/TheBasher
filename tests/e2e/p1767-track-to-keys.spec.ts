// p1767 (#1767) — a Track-To's keys are honoured: the camera's Track-To aim point is keyed from the
// origin (0 s) to a point down +X (1 s), and the DRAWN look-through camera follows it. Before the
// fix the constraint read its aim point as typed, so the camera stared at the origin throughout.
import { expect, test } from './_fixtures';

type V3 = [number, number, number];
interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_view_camera: () => { direction: V3; lookThrough: boolean } | null;
}

test('a keyed Track-To aim point turns the drawn camera', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_dag && w.__basher_view_camera && w.__basher_time);
  });
  await page.evaluate(() => {
    const d = (op: unknown) => (window as unknown as W).__basher_dag.getState().dispatch(op);
    d({ type: 'setParam', nodeId: 'n_camera', paramPath: 'position', value: [0, 0, 5] });
    d({
      type: 'addNode',
      nodeId: 'p1767_tt',
      nodeType: 'TrackTo',
      params: { target: 'n_camera', aimPoint: [0, 0, 0] },
    });
    d({
      type: 'addNode',
      nodeId: 'p1767_aim',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'aimPoint',
        target: 'p1767_tt',
        paramPath: 'aimPoint',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [10, 0, 5], easing: 'linear' },
        ],
      },
    });
  });
  await page.locator('body').click();
  await page.keyboard.press('0');
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as unknown as W).__basher_view_camera()))?.lookThrough ??
        false,
    )
    .toBe(true);
  const at = (t: number) =>
    page.evaluate(async (t) => {
      const w = window as unknown as W;
      w.__basher_time.getState().setTime(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
      return w.__basher_view_camera()!.direction;
    }, t);
  const d0 = await at(0);
  const d1 = await at(1);
  console.log(`p1767 0s ${JSON.stringify(d0)} 1s ${JSON.stringify(d1)}`);
  [0, 0, -1].forEach((v, i) => expect(d0[i], `0 s looks at the origin [${i}]`).toBeCloseTo(v, 3));
  [1, 0, 0].forEach((v, i) => expect(d1[i], `1 s looks down +X [${i}]`).toBeCloseTo(v, 3));
});

// p272b (#272) — the curve-editor interpolation PICKER authors a keyframe's
// interp; the rendered box follows (UI → setParam → render, H40).
import { expect, test } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { params: { keyframes?: { easing: string; ease?: string }[] } }>;
      };
      dispatchAtomic: (ops: unknown[], s?: string, l?: string) => void;
    };
  };
  __basher_viewport: { getState: () => { setTimelineDrawerOpen: (v: boolean) => void } };
  __basher_timeline_dock: { getState: () => { setActiveTab: (t: string) => void } };
  __basher_timeline_selection: {
    getState: () => {
      setActiveChannel: (id: string | null) => void;
      setActiveKeyframe: (r: { channelId: string; time: number } | null) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position?: (id: string) => [number, number, number] | null;
}
const CH = 'tmp272b_ch';

test('curve-editor interp picker drives the render', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => typeof (window as unknown as W).__basher_dag !== 'undefined');
  await page.waitForFunction(
    () => (window as unknown as W).__basher_mesh_world_position?.('n_box') != null,
  );
  await page.evaluate((id) => {
    const w = window as unknown as W;
    const dag = w.__basher_dag.getState();
    if (!dag.state.nodes[id]) {
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: id,
            nodeType: 'KeyframeChannelVec3',
            params: {
              name: 'pos',
              target: 'n_box',
              paramPath: 'position',
              keyframes: [
                { time: 0, value: [0, 0, 0], easing: 'linear' },
                { time: 2, value: [10, 0, 0], easing: 'linear' },
              ],
            },
          },
        ],
        'user',
        'tmp272b seed',
      );
    }
    w.__basher_viewport.getState().setTimelineDrawerOpen(true);
    w.__basher_timeline_dock.getState().setActiveTab('curve');
    w.__basher_timeline_selection.getState().setActiveChannel(id);
    w.__basher_timeline_selection.getState().setActiveKeyframe({ channelId: id, time: 2 });
  }, CH);

  await expect(page.getByTestId('curve-editor')).toBeVisible();
  const interp = page.getByTestId('curve-interp-select');
  await expect(interp).toBeVisible({ timeout: 10_000 });
  await expect(interp).toHaveValue('linear');
  // Ease select hidden for linear…
  await expect(page.getByTestId('curve-ease-select')).toHaveCount(0);

  // Pick 'back' → ease select appears; set it to 'out'.
  await interp.selectOption('back');
  const ease = page.getByTestId('curve-ease-select');
  await expect(ease).toBeVisible();
  await ease.selectOption('out');

  // DAG updated…
  const kf = await page.evaluate(
    (id) => (window as unknown as W).__basher_dag.getState().state.nodes[id].params.keyframes![1],
    CH,
  );
  expect(kf.easing).toBe('back');
  expect(kf.ease).toBe('out');

  // …and the render followed: back-out overshoots past x=10 at t=1.7.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1.7));
  await page.waitForFunction(() => {
    const p = (window as unknown as W).__basher_mesh_world_position!('n_box');
    return p !== null && p[0] > 10;
  });
  const x = (await page.evaluate(() =>
    (window as unknown as W).__basher_mesh_world_position!('n_box'),
  ))![0];
  expect(x, 'picker → render overshoots').toBeGreaterThan(10);
});

// #482 — a camera's channels obey mute, and so do the film's cuts, in the REAL viewport.
//
// The camera used to sample its keys in a private loop that read nothing else, so muting a
// keyed fov left the lens zoomed on screen while the inspector showed it unkeyed; and the cut
// channel was read the same way, so muting the cuts changed nothing that played. Both are read
// here off the look-through view camera (`__basher_view_camera`), what the director sees.
// Falsifiable: put either private read back and the muted rows show the keyed value.

import { test, expect } from './_fixtures';

interface View {
  position: [number, number, number];
  fov: number | null;
}
interface BasherWindow {
  __basher_view_camera?: () => View | null;
  __basher_viewport?: { getState: () => { lookThroughCamera: boolean } };
  __basher_time?: { getState: () => { setTime: (seconds: number) => void } };
  __basher_dag?: {
    getState: () => {
      dispatch: (op: unknown, source: string, desc: string) => void;
      dispatchAtomic: (ops: unknown[], source: string, desc: string) => void;
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
}

type Page = import('@playwright/test').Page;

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(
      w.__basher_view_camera && w.__basher_viewport && w.__basher_time && w.__basher_dag,
    );
  });
}

async function lookThrough(page: Page) {
  await page.keyboard.press('0');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as BasherWindow).__basher_viewport!.getState().lookThroughCamera,
      ),
    )
    .toBe(true);
}

/** The view camera at `seconds`, once it has settled there. */
async function viewAt(page: Page, seconds: number, settled: (v: View) => boolean): Promise<View> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time!.getState().setTime(s),
    seconds,
  );
  let last: View | null = null;
  await expect
    .poll(async () => {
      last = await page.evaluate(() => (window as unknown as BasherWindow).__basher_view_camera!());
      return last !== null && settled(last);
    })
    .toBe(true);
  return last!;
}

const setParam = (page: Page, nodeId: string, paramPath: string, value: unknown) =>
  page.evaluate(
    ({ nodeId, paramPath, value }) =>
      (window as unknown as BasherWindow)
        .__basher_dag!.getState()
        .dispatch({ type: 'setParam', nodeId, paramPath, value }, 'user', `set ${paramPath}`),
    { nodeId, paramPath, value },
  );

test('muting a keyed fov puts the lens back, and unmuting zooms again', async ({ page }) => {
  await ready(page);
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_dag!.getState().dispatch(
      {
        type: 'addNode',
        nodeId: 'fov_ch',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'fov',
          target: 'n_camera_data',
          paramPath: 'fov',
          keyframes: [
            { time: 0, value: 20, easing: 'linear' },
            { time: 2, value: 80, easing: 'linear' },
          ],
        },
      },
      'user',
      'key fov',
    ),
  );
  await lookThrough(page);

  // The default camera's lens is 45; the keys put it at 50 at 1 s.
  expect((await viewAt(page, 1, (v) => Math.abs(v.fov! - 50) < 0.5)).fov).toBeCloseTo(50, 0);
  await setParam(page, 'fov_ch', 'mute', true);
  expect((await viewAt(page, 1, (v) => Math.abs(v.fov! - 45) < 0.5)).fov).toBeCloseTo(45, 0);
  await setParam(page, 'fov_ch', 'mute', false);
  expect((await viewAt(page, 1, (v) => Math.abs(v.fov! - 50) < 0.5)).fov).toBeCloseTo(50, 0);
});

test('muting the cut channel plays the switch’s own camera', async ({ page }) => {
  await ready(page);
  // A second camera at x = 10 and one cut to it at 2 s, made by the shots panel's own edit. The
  // switch it inserts has cam2 as its own camera, so before the cut the film shows the default
  // camera (at x = 3) only because of the cut keys.
  const cut = await page.evaluate(async () => {
    const { makeSplitCamera } = await import('/src/test-utils/splitCamera.ts');
    const { buildCutOps } = await import('/src/app/shotOps.ts');
    const { cutChannelOf } = await import('/src/app/activeCamera.ts');
    const { useDagStore } = await import('/src/core/dag/store.ts');
    const withCam = makeSplitCamera(useDagStore.getState().state, {
      objectId: 'cam2',
      position: [10, 0, 0],
    }).state;
    useDagStore.setState({ state: withCam });
    useDagStore.getState().dispatchAtomic(buildCutOps(withCam, 2, 'cam2')!, 'user', 'cut');
    const s = useDagStore.getState().state;
    const select = Object.values(s.nodes).find((n) => n.type === 'CameraSelect')!;
    return {
      channel: cutChannelOf(s, select.id)!.id,
      own: (select.params as { active: string }).active,
    };
  });
  expect(cut.own).toBe('cam2');
  await lookThrough(page);

  const atX = (x: number) => (v: View) => Math.abs(v.position[0] - x) < 0.01;
  expect((await viewAt(page, 1, atX(3))).position[0]).toBeCloseTo(3, 2);
  await setParam(page, cut.channel, 'mute', true);
  expect((await viewAt(page, 1, atX(10))).position[0]).toBeCloseTo(10, 2);
  await setParam(page, cut.channel, 'mute', false);
  expect((await viewAt(page, 1, atX(3))).position[0]).toBeCloseTo(3, 2);
});

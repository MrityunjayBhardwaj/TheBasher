// p1708 (#1708) — free view with the Shots tab open. Look-through is a viewport setting, not a
// side effect of picking a shot: a click on a shot selects its camera and moves the playhead, and
// leaves the view where it is; a double-click looks through; Esc or an orbit drag comes back out.
//
// Three cameras told apart by X (the seed camera near 0, 20, 40), two cuts. What is asserted is
// read off the live view camera (`__basher_view_camera`) and the stores, never the rows' own data.
import { expect, settleViewFit, test } from './_fixtures';
import type { Page } from '@playwright/test';
import { splitCameraOps } from './_splitCamera';
import { openDrawerTab } from './_drawer';

test.setTimeout(120_000);

interface ViewCam {
  position: [number, number, number];
  direction: [number, number, number];
  lookThrough: boolean;
}
interface W {
  __basher_dag: { getState: () => { dispatch: (op: unknown) => void } };
  __basher_time: {
    getState: () => { setTime: (s: number) => void; filmSeconds: number; playing: boolean };
  };
  __basher_viewport: { getState: () => { lookThroughCamera: boolean } };
  __basher_selection: { getState: () => { primaryNodeId: string | null } };
  __basher_view_camera: () => ViewCam | null;
}

const CAM2 = 'p1708_cam2';
const CAM3 = 'p1708_cam3';

async function boot(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* not present */
      }
    }
    localStorage.removeItem('basher.timelineDock.v1');
    localStorage.removeItem('basher.livePreview.v1');
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return Boolean(w.__basher_dag && w.__basher_time && w.__basher_view_camera);
  });
  await page.evaluate(
    (ops) => {
      for (const op of ops) (window as unknown as W).__basher_dag.getState().dispatch(op);
    },
    [
      ...splitCameraOps({ objectId: CAM2, position: [20, 2, 8], lookAt: [20, 0, 0] }),
      ...splitCameraOps({ objectId: CAM3, position: [40, 2, 8], lookAt: [40, 0, 0] }),
    ],
  );
  await openDrawerTab(page, 'shots');
  await setPlayhead(page, 2);
  await page.getByTestId('shots-cut-camera').selectOption(CAM3);
  await page.getByTestId('shots-cut-here').click();
  await setPlayhead(page, 4);
  await page.getByTestId('shots-cut-camera').selectOption(CAM2);
  await page.getByTestId('shots-cut-here').click();
  await expect(page.locator('[data-testid^="shot-row-"]')).toHaveCount(3);
  await setPlayhead(page, 0);
  await settleViewFit(page);
}

const setPlayhead = (page: Page, s: number) =>
  page.evaluate((sec) => (window as unknown as W).__basher_time.getState().setTime(sec), s);

/** The live view camera, read after two frames so any write this frame has landed. */
const viewCam = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return (window as unknown as W).__basher_view_camera()!;
  });

const lookThrough = (page: Page) =>
  page.evaluate(() => (window as unknown as W).__basher_viewport.getState().lookThroughCamera);

function expectSameView(a: ViewCam, b: ViewCam) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(a.position[i] - b.position[i]), `position[${i}]`).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(a.direction[i] - b.direction[i]), `direction[${i}]`).toBeLessThanOrEqual(1e-6);
  }
}

test('selecting a shot selects its camera and moves the playhead, but not the view', async ({
  page,
}) => {
  await boot(page);
  expect(await lookThrough(page)).toBe(false);
  const before = await viewCam(page);

  await page.getByTestId('shot-select-1').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_time.getState().filmSeconds))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId),
    'the shot selected the camera that films it',
  ).toBe(CAM3);
  expect(await lookThrough(page), 'a click does not look through').toBe(false);
  const after = await viewCam(page);
  console.log(`p1708 view before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  expectSameView(after, before);
  // Picking another shot moves the selection with it, and still not the view.
  await page.getByTestId('shot-select-2').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_selection.getState().primaryNodeId),
    )
    .toBe(CAM2);
  expectSameView(await viewCam(page), before);
  await expect(page.getByTestId('shot-select-1')).toHaveAttribute('title', /Double-click/);
});

test('double-click looks through; Esc and an orbit drag come back to the free view', async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId('shot-select-1').dblclick();
  await expect.poll(() => lookThrough(page)).toBe(true);
  expect(Math.round((await viewCam(page)).position[0]), 'through the shot camera').toBe(40);

  await page.keyboard.press('Escape');
  await expect.poll(() => lookThrough(page), 'Esc returns to the free view').toBe(false);

  await page.getByTestId('shot-select-2').dblclick();
  await expect.poll(() => lookThrough(page)).toBe(true);
  const box = (await page.getByTestId('viewport-canvas').boundingBox())!;
  const x = box.x + box.width * 0.3;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => lookThrough(page), 'an orbit drag returns to the free view').toBe(false);

  // A plain click in camera view (a pick, no drag) stays in camera view.
  await page.keyboard.press('0');
  await expect.poll(() => lookThrough(page)).toBe(true);
  await page.mouse.click(x, y);
  await page.waitForTimeout(100);
  expect(await lookThrough(page), 'a click is not an orbit').toBe(true);

  expect(await page.getByTestId('viewport').locator('canvas').count(), 'one viewport canvas').toBe(
    1,
  );
});

interface FrustumStyle {
  color: string;
  opacity: number;
}
interface LivePath {
  cameraId: string;
  points: [number, number, number][];
  dashed: boolean;
  color: string;
  chrome: boolean;
}

/** Key `CAM3`'s position across its shot (2 s → 4 s), so it has a path to draw. */
async function animateCam3(page: Page) {
  await page.evaluate((target) => {
    (window as unknown as W).__basher_dag.getState().dispatch({
      type: 'addNode',
      nodeId: 'p1708_cam3_pos',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'position',
        target,
        paramPath: 'position',
        keyframes: [
          { time: 2, value: [36, 2, 8], easing: 'linear' },
          { time: 4, value: [44, 2, 8], easing: 'linear' },
        ],
      },
    });
  }, CAM3);
}

const frustumStyles = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return (window as unknown as { __basher_frustum_style?: Record<string, FrustumStyle> })
      .__basher_frustum_style!;
  });

const livePath = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    return (
      (window as unknown as { __basher_live_camera_path?: LivePath | null })
        .__basher_live_camera_path ?? null
    );
  });

test('cameras draw in their shot colour; the live one is solid with its path dashed behind it', async ({
  page,
}) => {
  await boot(page);
  await animateCam3(page);
  // Palette order is the order cameras first come on screen: seed camera, CAM3, CAM2.
  const BLUE = '4ea1ff';
  const AMBER = 'e0a940';
  const VIOLET = 'a78bfa';

  let s = await frustumStyles(page);
  console.log(`p1708 frames at 0: ${JSON.stringify(s)}`);
  expect(s.n_camera.color).toBe(BLUE);
  expect(s[CAM3].color).toBe(AMBER);
  expect(s[CAM2].color).toBe(VIOLET);
  expect(s.n_camera.opacity, 'the live camera is solid').toBe(1);
  expect(s[CAM3].opacity, 'a camera off screen is dimmer').toBeLessThan(1);
  // The seed camera does not move, so it has no path to draw.
  expect(await livePath(page)).toBeNull();

  await setPlayhead(page, 3);
  s = await frustumStyles(page);
  console.log(`p1708 frames at 3: ${JSON.stringify(s)}`);
  expect(s[CAM3].opacity).toBe(1);
  expect(s.n_camera.opacity).toBeLessThan(1);
  const path = (await livePath(page))!;
  console.log(
    `p1708 path: ${path.cameraId} ${path.points.length} points ${JSON.stringify(path.points[0])} → ${JSON.stringify(path.points.at(-1))} dashed=${path.dashed} chrome=${path.chrome}`,
  );
  expect(path.cameraId).toBe(CAM3);
  expect(path.dashed).toBe(true);
  expect(path.color).toBe(AMBER);
  expect(path.chrome, 'the path is editor chrome: never in a render').toBe(true);
  expect(path.points.length).toBeGreaterThan(8);
  expect(path.points[0][0]).toBeCloseTo(36, 3);
  expect(path.points.at(-1)![0]).toBeCloseTo(44, 1);

  // Selected keeps its shot colour.
  await page.getByTestId('shot-select-2').click();
  s = await frustumStyles(page);
  expect(s[CAM2].color).toBe(VIOLET);
  // The Shots list wears the same colours.
  await expect(page.getByTestId('shot-color-1')).toHaveAttribute('data-color', `#${AMBER}`);
});

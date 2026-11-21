// p1709 (#1709) — one fixed split: the 2D View shows the 3D view beside it.
//
// Decided design (editor boards 11a/11b): 2D on the left, 3D on the right, a 6 px draggable
// divider between. The 3D side has a small header — "3D · free camera", Frame, ⇄ swap, ⇥ collapse —
// and collapsed it is a 34 px strip with ⇤ to bring it back. The UV mode opens split; Render result
// opens unsplit. The 3D side is the editor's free camera, never a shot camera.
//
// Done when: collapsing and expanding keeps both sides' state (camera, zoom), and the drawer and
// chat column are unaffected. The split reuses the ONE canvas — it is never a second renderer.
//
// What is asserted is read off the live surfaces: the view camera (`__basher_view_camera`), the
// orbit pivot (`__basher_three`), the 2D canvas's own view transform (its data-view-* attributes),
// the canvas element and its drawing buffer, and the slots' boxes.
//
// REF: src/app/Layout.tsx; src/app/SplitChrome.tsx; src/app/stores/splitViewStore.ts;
//      src/app/layoutIslands.ts (splitPaneBoxes); src/app/usePanZoomCanvas.ts.
import type { Page } from '@playwright/test';
import { expect, settleViewFit, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

test.setTimeout(120_000);

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface W {
  __basher_view_camera: () => { position: [number, number, number] } | null;
  __basher_three: { getState: () => { controlsTarget: V3 | null } };
  __basher_viewport: {
    getState: () => { lookThroughCamera: boolean; setLookThroughCamera: (on: boolean) => void };
  };
}

type Box = { x: number; y: number; width: number; height: number };

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
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
    for (const k of [
      'basher.splitView.v1',
      'basher.twoDView.v1',
      'basher.timelineDock.v1',
      'basher.chatColumn.v1',
      'basher.chrome.v1',
    ]) {
      localStorage.removeItem(k);
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<W>;
    return Boolean(w.__basher_view_camera && w.__basher_three && w.__basher_viewport);
  });
  await settleViewFit(page);
}

async function box(page: Page, id: string): Promise<Box> {
  const b = await page.getByTestId(id).first().boundingBox();
  if (!b) throw new Error(`no box for ${id}`);
  return b;
}

/** The free camera: position and orbit pivot, read after two frames so this frame's writes landed. */
const freeCam = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const w = window as unknown as W;
    const t = w.__basher_three.getState().controlsTarget!;
    return { position: w.__basher_view_camera()!.position, target: [t.x, t.y, t.z] };
  });

/** The free camera once the orbit's damping has run out (drei's OrbitControls glides on after a
 *  drag ends, dampingFactor 0.08): two reads 10 frames apart that agree. */
async function restingCam(page: Page) {
  let prev = await freeCam(page);
  for (let i = 0; i < 100; i++) {
    await page.evaluate(
      () =>
        new Promise((r) => {
          let n = 0;
          const tick = () => (++n >= 10 ? r(null) : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
    const next = await freeCam(page);
    const same = [0, 1, 2].every(
      (k) => next.position[k] === prev.position[k] && next.target[k] === prev.target[k],
    );
    if (same) return next;
    prev = next;
  }
  throw new Error('the free camera never came to rest');
}

function expectSameCam(
  a: { position: number[]; target: number[] },
  b: { position: number[]; target: number[] },
  label: string,
) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(a.position[i] - b.position[i]), `${label}: position[${i}]`).toBeLessThanOrEqual(
      1e-6,
    );
    expect(Math.abs(a.target[i] - b.target[i]), `${label}: target[${i}]`).toBeLessThanOrEqual(1e-6);
  }
}

/** The 2D canvas's own view transform, as it last painted. */
const twoDView = (page: Page) =>
  page.getByTestId('uv-editor-canvas').evaluate((c) => ({
    zoom: Number((c as HTMLCanvasElement).dataset.viewZoom),
    panX: Number((c as HTMLCanvasElement).dataset.viewPanX),
    panY: Number((c as HTMLCanvasElement).dataset.viewPanY),
  }));

/** Tag the one 3D canvas so a remount (a fresh element) cannot pass for the same one. */
const tagCanvas = (page: Page) =>
  page.evaluate(() => {
    const cs = document.querySelectorAll('[data-testid="view3d-slot"] canvas');
    (cs[0] as unknown as { __p1709: string }).__p1709 = 'same';
    return cs.length;
  });
const canvasStillTagged = (page: Page) =>
  page.evaluate(() => {
    const cs = document.querySelectorAll('[data-testid="view3d-slot"] canvas');
    return {
      count: cs.length,
      tagged: (cs[0] as unknown as { __p1709?: string } | undefined)?.__p1709 === 'same',
    };
  });

/** The 3D canvas's CSS box and drawing buffer width must track the 3D side's width. */
async function expectCanvasFillsSide(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await page.evaluate(() => {
          const slot = document.querySelector('[data-testid="view3d-slot"]') as HTMLElement;
          const c = slot.querySelector('canvas') as HTMLCanvasElement;
          const cr = c.getBoundingClientRect();
          return {
            slotW: slot.clientWidth,
            cssW: cr.width,
            bufW: c.width,
            dpr: Math.min(2, Math.max(1, window.devicePixelRatio)),
          };
        });
        return (
          Math.abs(r.cssW - r.slotW) <= 1 &&
          Math.abs(r.bufW - Math.round(r.slotW * r.dpr)) <= Math.ceil(r.dpr)
        );
      },
      { message: 'the canvas (box and drawing buffer) fills the 3D side', timeout: 5_000 },
    )
    .toBe(true);
}

async function enterUV(page: Page): Promise<void> {
  await page.getByTestId('space-switch-uv').click();
  await expect(page.getByTestId('uv-slot')).toBeVisible();
}

test('the UV mode opens split: 2D left, 3D right, one canvas sized to its side', async ({
  page,
}) => {
  await boot(page);
  expect(await tagCanvas(page)).toBe(1);
  await enterUV(page);
  await expect(page.getByTestId('view3d-slot')).toBeVisible();
  await expect(page.getByTestId('split-divider')).toBeVisible();
  await expect(page.getByTestId('split-3d-header')).toContainText('3D');
  await expect(page.getByTestId('split-3d-header')).toContainText('free camera');
  await expect(page.getByTestId('split-frame')).toContainText('Frame');
  // Every header control sits inside the 3D side, even at its narrowest default (1440 px with the
  // chat and inspector open): the header gives way in its label, never in its buttons.
  const side = await box(page, 'view3d-slot');
  for (const id of ['split-swap', 'split-collapse']) {
    const b = await box(page, id);
    expect(b.x + b.width, `${id} inside the 3D side`).toBeLessThanOrEqual(side.x + side.width);
  }

  const twoD = await box(page, 'uv-slot');
  const div = await box(page, 'split-divider');
  const threeD = await box(page, 'view3d-slot');
  expect(div.width).toBeCloseTo(6, 0);
  expect(twoD.x + twoD.width, '2D ends at the divider').toBeLessThanOrEqual(div.x + 1);
  expect(threeD.x, '3D starts after the divider').toBeGreaterThanOrEqual(div.x + div.width - 1);
  expect(Math.abs(twoD.y - threeD.y), 'the two sides share a top').toBeLessThanOrEqual(1);
  // Clear of the side islands: the 3D side ends before the inspector island.
  const inspector = await box(page, 'inspector-slot');
  expect(threeD.x + threeD.width).toBeLessThanOrEqual(inspector.x);
  const tree = await box(page, 'tree-slot');
  expect(twoD.x).toBeGreaterThanOrEqual(tree.x + tree.width);

  expect(await canvasStillTagged(page)).toEqual({ count: 1, tagged: true });
  await expectCanvasFillsSide(page);
});

test('collapse → expand and swap keep the free camera and the 2D zoom; drawer and chat stay put', async ({
  page,
}) => {
  await boot(page);
  await openDrawerTab(page, 'dopesheet');
  expect(await tagCanvas(page)).toBe(1);
  await enterUV(page);
  await expect(page.getByTestId('view3d-slot')).toBeVisible();
  await expectCanvasFillsSide(page);

  // Move both views off their defaults, so "kept" cannot pass by both resetting to the same place.
  const uvCanvas = page.getByTestId('uv-editor-canvas');
  const ub = (await uvCanvas.boundingBox())!;
  await page.mouse.move(ub.x + ub.width * 0.4, ub.y + ub.height * 0.4);
  await page.mouse.wheel(0, -300);
  await page.mouse.down();
  await page.mouse.move(ub.x + ub.width * 0.4 + 30, ub.y + ub.height * 0.4 + 20, { steps: 4 });
  await page.mouse.up();
  const zoom0 = await twoDView(page);
  expect(zoom0.zoom, 'the 2D view zoomed').toBeGreaterThan(1.05);

  const tb = await box(page, 'view3d-slot');
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 60, tb.y + tb.height / 2 + 15, { steps: 6 });
  await page.mouse.up();
  const cam0 = await restingCam(page);

  const drawer0 = await box(page, 'timeline-slot');
  const chat0 = await box(page, 'agentdock-slot');

  // Collapse: the 3D side becomes the strip.
  await page.getByTestId('split-collapse').click();
  await expect(page.getByTestId('split-collapsed-strip')).toBeVisible();
  await expect(page.getByTestId('split-collapsed-strip')).toContainText('3D view · collapsed');
  await expect(page.getByTestId('view3d-slot')).toBeHidden();
  await expect(page.getByTestId('split-divider')).toBeHidden();
  const strip = await box(page, 'split-collapsed-strip');
  expect(strip.width).toBeCloseTo(34, 0);
  expect(await box(page, 'timeline-slot'), 'drawer unaffected by collapse').toEqual(drawer0);
  expect(await box(page, 'agentdock-slot'), 'chat unaffected by collapse').toEqual(chat0);
  expect((await twoDView(page)).zoom).toBe(zoom0.zoom);

  // Expand: both sides' state as they were.
  await page.getByTestId('split-expand').click();
  await expect(page.getByTestId('view3d-slot')).toBeVisible();
  expectSameCam(await freeCam(page), cam0, 'after collapse → expand');
  expect(await twoDView(page), '2D view after collapse → expand').toEqual(zoom0);
  expect(await box(page, 'timeline-slot'), 'drawer unaffected by expand').toEqual(drawer0);
  expect(await box(page, 'agentdock-slot'), 'chat unaffected by expand').toEqual(chat0);
  expect(await canvasStillTagged(page)).toEqual({ count: 1, tagged: true });
  await expectCanvasFillsSide(page);

  // Swap: 3D on the left, 2D on the right, same state.
  await page.getByTestId('split-swap').click();
  await expect
    .poll(async () => (await box(page, 'view3d-slot')).x < (await box(page, 'uv-slot')).x)
    .toBe(true);
  expectSameCam(await freeCam(page), cam0, 'after swap');
  expect(await twoDView(page), '2D view after swap').toEqual(zoom0);
  expect(await box(page, 'timeline-slot'), 'drawer unaffected by swap').toEqual(drawer0);
  expect(await box(page, 'agentdock-slot'), 'chat unaffected by swap').toEqual(chat0);
  expect(await canvasStillTagged(page)).toEqual({ count: 1, tagged: true });
  await expectCanvasFillsSide(page);

  // Collapsed while swapped: the strip sits on the 3D side's edge (the left).
  await page.getByTestId('split-collapse').click();
  const stripL = await box(page, 'split-collapsed-strip');
  expect(stripL.x).toBeLessThan((await box(page, 'uv-slot')).x);
  await page.getByTestId('split-expand').click();
  expectSameCam(await freeCam(page), cam0, 'after swapped collapse → expand');
  await expectCanvasFillsSide(page);
});

test('Render result opens unsplit; going back to UV splits again', async ({ page }) => {
  await boot(page);
  await enterUV(page);
  await expect(page.getByTestId('split-divider')).toBeVisible();
  await page.getByTestId('twodview-tab-render').click();
  await expect(page.getByTestId('view3d-slot')).toBeHidden();
  await expect(page.getByTestId('split-divider')).toBeHidden();
  await expect(page.getByTestId('split-collapsed-strip')).toBeHidden();
  await page.getByTestId('twodview-tab-uv').click();
  await expect(page.getByTestId('view3d-slot')).toBeVisible();
  await expect(page.getByTestId('split-divider')).toBeVisible();
  // The split is a per-mode choice: turned off in UV, it stays off there.
  await page.getByTestId('twodview-split-toggle').click();
  await expect(page.getByTestId('view3d-slot')).toBeHidden();
  await page.getByTestId('twodview-tab-render').click();
  await page.getByTestId('twodview-tab-uv').click();
  await expect(page.getByTestId('view3d-slot')).toBeHidden();
});

test('dragging the divider resizes the sides, and the split survives a reload', async ({
  page,
}) => {
  await boot(page);
  await enterUV(page);
  const twoD0 = await box(page, 'uv-slot');
  const div = await box(page, 'split-divider');
  await page.mouse.move(div.x + 3, div.y + div.height / 2);
  await page.mouse.down();
  await page.mouse.move(div.x + 3 - 120, div.y + div.height / 2, { steps: 8 });
  await page.mouse.up();
  const twoD1 = await box(page, 'uv-slot');
  expect(twoD0.width - twoD1.width, 'the 2D side lost the dragged width').toBeGreaterThan(100);
  expect(twoD0.width - twoD1.width).toBeLessThan(140);
  await expectCanvasFillsSide(page);

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await enterUV(page);
  const twoD2 = await box(page, 'uv-slot');
  expect(Math.abs(twoD2.width - twoD1.width), 'the ratio persisted').toBeLessThanOrEqual(1);
});

test('the 3D side is the free view: a look-through on entry comes back out', async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    (window as unknown as W).__basher_viewport.getState().setLookThroughCamera(true),
  );
  await enterUV(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as W).__basher_viewport.getState().lookThroughCamera),
    )
    .toBe(false);
});

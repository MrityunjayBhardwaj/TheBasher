// p1955 (#1955) — the Nodes tab's view flag is a way of looking, never part of the film.
//
// With an Array of 3 on the box and the box's data flagged, the viewport shows one box while every
// output — the still render (F12, the Generated tab's first frame, saved passes and the animation
// export all go through it) and the live shot preview — shows the finished three. Houdini keeps
// its display flag apart from what renders; so do we.
//
// Read off the live surfaces: the still render's own PNG (`__basher_render_png`, the road F12
// takes), the viewport's pixels and the preview's pixels (page screenshots of their boxes), each
// compared against the same surface with nothing flagged.
//
// REF: src/app/viewFlag.ts (viewedState); src/app/renderVisibility.ts (withRenderVisibility);
//      src/viewport/LivePreviewPass.tsx.
import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

test.setTimeout(120_000);

interface W {
  __basher_dag: {
    getState: () => {
      state: unknown;
      dispatchAtomic: (o: unknown[], s: string, l: string) => void;
    };
  };
  __basher_render_png: () => Promise<{ dataUrl: string } | null>;
  __basher_live_preview?: { renders: number };
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as Partial<W>).__basher_render_png));
  await page.evaluate(async () => {
    const { buildAddModifierOps } = await import('/src/app/operatorStack.ts');
    const dag = (window as unknown as W).__basher_dag.getState();
    const add = buildAddModifierOps(dag.state as never, 'n_box_data', 'ArrayModifier', {
      count: 3,
    });
    dag.dispatchAtomic(add!.ops, 'user', 'add array');
  });
  await openDrawerTab(page, 'nodes');
}

const render = (page: Page) =>
  page.evaluate(async () => (await (window as unknown as W).__basher_render_png())!.dataUrl);

/** How many pixels of two PNG data URLs differ by more than a hair, out of how many. */
const pixelDiff = (page: Page, a: string, b: string) =>
  page.evaluate(
    async ([a, b]) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const [pa, pb] = await Promise.all([load(a), load(b)]);
      let diff = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (
          Math.abs(pa[i] - pb[i]) > 24 ||
          Math.abs(pa[i + 1] - pb[i + 1]) > 24 ||
          Math.abs(pa[i + 2] - pb[i + 2]) > 24
        )
          diff++;
      }
      return { diff, total: pa.length / 4 };
    },
    [a, b] as const,
  );

const shot = async (page: Page, id: string) =>
  `data:image/png;base64,${(
    await page.screenshot({ clip: (await page.getByTestId(id).boundingBox())! })
  ).toString('base64')}`;

/** Let the viewport settle and the preview redraw at least twice (it refreshes idle ~0.5 s). */
async function settle(page: Page): Promise<void> {
  const before = await page.evaluate(
    () => (window as unknown as W).__basher_live_preview?.renders ?? 0,
  );
  await page.waitForFunction(
    (n) => ((window as unknown as W).__basher_live_preview?.renders ?? 0) >= n + 2,
    before,
    { timeout: 20_000 },
  );
}

const flag = (page: Page) =>
  page.getByTestId('graph-view').getByTestId('graph-view-flag-n_box_data');

test('a flagged step shows in the viewport, never in a render or the live preview', async ({
  page,
}) => {
  await boot(page);
  await settle(page);
  const finalRender = await render(page);
  const finalView = await shot(page, 'viewport');
  const finalPreview = await shot(page, 'live-preview');

  await flag(page).click();
  await expect(flag(page)).toHaveAttribute('data-viewing', 'true');
  await settle(page);

  // The premise: the viewport does show the flagged step (one box, not three).
  const view = await pixelDiff(page, finalView, await shot(page, 'viewport'));
  expect(view.diff, 'the viewport changed with the flag').toBeGreaterThan(500);

  // A render made while the step is flagged is the finished three.
  const flaggedRender = await render(page);
  const r = await pixelDiff(page, finalRender, flaggedRender);
  expect(r.diff / r.total, `render differs on ${r.diff} of ${r.total} px`).toBeLessThan(0.001);

  // And so is the live shot preview, after it has redrawn with the flag set.
  const p = await pixelDiff(page, finalPreview, await shot(page, 'live-preview'));
  expect(p.diff / p.total, `preview differs on ${p.diff} of ${p.total} px`).toBeLessThan(0.002);

  await page.screenshot({
    path: '/private/tmp/claude-501/-Users-mrityunjaybhardwaj-Documents-projects-basher-ai/eda82755-8702-4c9c-a8d7-95247e70fa04/scratchpad/p1955-flagged.png',
  });

  // A real click on the step the viewport shows selects the object (not its stand-in).
  const at = await page.evaluate(() => {
    type V = { x: number; y: number };
    const w = window as unknown as {
      __basher_three: {
        getState: () => {
          camera: {
            updateMatrixWorld: () => void;
            position: { clone: () => { set: (...a: number[]) => { project: (c: unknown) => V } } };
          };
        };
      };
      __basher_mesh_world_position: (id: string) => [number, number, number] | null;
    };
    const cam = w.__basher_three.getState().camera;
    cam.updateMatrixWorld();
    const p = w.__basher_mesh_world_position('n_box~viewing');
    if (!p) return null;
    const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam);
    const r = (
      document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement
    ).getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  });
  expect(at, 'the stand-in is drawn').not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const m = await import('/src/app/stores/selectionStore.ts');
        return m.useSelectionStore.getState().primaryNodeId;
      }),
    )
    .toBe('n_box');

  // Unflagged again, the viewport is back to the finished three.
  await flag(page).click();
  await settle(page);
  const back = await pixelDiff(page, finalView, await shot(page, 'viewport'));
  expect(back.diff / back.total).toBeLessThan(0.002);
});

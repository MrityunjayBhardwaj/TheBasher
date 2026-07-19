// #226 — viewport box (marquee) select. The `B` shortcut arms a crosshair
// overlay; a drag selects every top-level object whose ORIGIN projects inside the
// marquee (Blender object-mode parity). Shift-box ADDS to the set; a box on empty
// space (replace mode) clears it.
//
// Boundary-pair: side A = the live camera PROJECTION of each object origin
// (__basher_box_select_project), side B = the resulting selection set after the
// hit test (__basher_selection). They must agree — a box drawn around an object's
// projected origin selects exactly that object.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';

interface BoxSelectWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string }> };
      dispatchAtomic: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_selection: {
    getState: () => {
      selectedNodeIds: ReadonlySet<string>;
      primaryNodeId: string | null;
      select: (id: string | null) => void;
      selectMany: (ids: string[]) => void;
    };
  };
  __basher_box_select: (x0: number, y0: number, x1: number, y1: number, additive?: boolean) => void;
  __basher_box_select_project: (w: [number, number, number]) => {
    x: number;
    y: number;
    visible: boolean;
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const w = window as unknown as BoxSelectWindow;
      return Boolean(w.__basher_dag && w.__basher_selection && w.__basher_box_select);
    },
    { timeout: 15000 },
  );
  // Add a second box at x=3 so the two objects project to distinct screen points.
  await page.evaluate(
    ({ ops }) => {
      const w = window as unknown as BoxSelectWindow;
      const dag = w.__basher_dag.getState();
      const sceneId = dag.state.outputs.scene.node;
      dag.dispatchAtomic(
        [
          ...ops,
          {
            type: 'connect',
            from: { node: 'n_box_b', socket: 'out' },
            to: { node: sceneId, socket: 'children' },
          },
        ],
        'user',
        'add second box',
      );
      w.__basher_selection.getState().select(null);
    },
    { ops: splitCubeOps({ objectId: 'n_box_b', position: [3, 0, 0] }) },
  );
});

test('a box around one origin selects exactly that object (and makes it active)', async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const w = window as unknown as BoxSelectWindow;
    const p = w.__basher_box_select_project([0, 0, 0]); // n_box at origin
    w.__basher_box_select(p.x - 15, p.y - 15, p.x + 15, p.y + 15, false);
    const s = w.__basher_selection.getState();
    return { visible: p.visible, ids: [...s.selectedNodeIds], primary: s.primaryNodeId };
  });
  expect(result.visible).toBe(true);
  expect(result.ids).toEqual(['n_box']);
  expect(result.primary).toBe('n_box');
});

test('a box around both origins selects both', async ({ page }) => {
  const ids = await page.evaluate(() => {
    const w = window as unknown as BoxSelectWindow;
    const a = w.__basher_box_select_project([0, 0, 0]);
    const b = w.__basher_box_select_project([3, 0, 0]);
    w.__basher_box_select(
      Math.min(a.x, b.x) - 20,
      Math.min(a.y, b.y) - 20,
      Math.max(a.x, b.x) + 20,
      Math.max(a.y, b.y) + 20,
      false,
    );
    return [...w.__basher_selection.getState().selectedNodeIds];
  });
  expect(ids.sort()).toEqual(['n_box', 'n_box_b']);
});

test('Shift-box ADDS to the existing selection', async ({ page }) => {
  const ids = await page.evaluate(() => {
    const w = window as unknown as BoxSelectWindow;
    w.__basher_selection.getState().select('n_box_b');
    const p = w.__basher_box_select_project([0, 0, 0]);
    w.__basher_box_select(p.x - 15, p.y - 15, p.x + 15, p.y + 15, true);
    return [...w.__basher_selection.getState().selectedNodeIds];
  });
  expect(ids.sort()).toEqual(['n_box', 'n_box_b']);
});

test('a replace-box over empty space clears the selection', async ({ page }) => {
  const ids = await page.evaluate(() => {
    const w = window as unknown as BoxSelectWindow;
    w.__basher_selection.getState().selectMany(['n_box', 'n_box_b']);
    w.__basher_box_select(2, 2, 22, 22, false); // top-left corner, no object there
    return [...w.__basher_selection.getState().selectedNodeIds];
  });
  expect(ids).toEqual([]);
});

test('B arms the crosshair overlay; Esc cancels it without changing the set', async ({ page }) => {
  await page.evaluate(() =>
    (window as unknown as BoxSelectWindow).__basher_selection.getState().selectMany(['n_box']),
  );
  const overlay = page.locator('[data-testid="box-select-overlay"]');
  await expect(overlay).toHaveCount(0);

  await page.locator('[data-testid="viewport"]').click({ position: { x: 640, y: 160 } });
  await page.keyboard.press('b');
  await expect(overlay).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});

test('a real pointer drag draws the marquee and selects the enclosed objects', async ({ page }) => {
  const vp = page.locator('[data-testid="viewport"]');
  const box = await vp.boundingBox();
  if (!box) throw new Error('no viewport bounding box');
  const proj = await page.evaluate(() => {
    const w = window as unknown as BoxSelectWindow;
    return {
      a: w.__basher_box_select_project([0, 0, 0]),
      b: w.__basher_box_select_project([3, 0, 0]),
    };
  });
  await page.evaluate(() =>
    (window as unknown as BoxSelectWindow).__basher_selection.getState().select(null),
  );
  await vp.click({ position: { x: 640, y: 160 } });
  await page.keyboard.press('b');

  const x0 = box.x + Math.min(proj.a.x, proj.b.x) - 25;
  const y0 = box.y + Math.min(proj.a.y, proj.b.y) - 25;
  const x1 = box.x + Math.max(proj.a.x, proj.b.x) + 25;
  const y1 = box.y + Math.max(proj.a.y, proj.b.y) + 25;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await page.mouse.move(x1, y1, { steps: 3 });
  await expect(page.locator('[data-testid="box-select-marquee"]')).toHaveCount(1);
  await page.mouse.up();

  // One box per B press: the overlay exits after release (Blender idiom).
  await expect(page.locator('[data-testid="box-select-overlay"]')).toHaveCount(0);
  const ids = await page.evaluate(() => [
    ...(window as unknown as BoxSelectWindow).__basher_selection.getState().selectedNodeIds,
  ]);
  expect(ids.sort()).toEqual(['n_box', 'n_box_b']);
});

// P6 W5 (v0.6 #4) — first-run polish: empty-state hints, visual ADD palette,
// click-to-select confirm.
//
// Proves the three first-run affordances on the REAL surface a first-timer
// sees — an example opened from the HOME into the calm, mode-free editor:
//   #1 empty-state hints (viewport + NPanel) show while nothing is selected
//      and clear once an object is selected (W5-T2).
//   #2 the visual ADD palette (the pill's Add → AddMenu) creates a REAL Op-built
//      DAG node and auto-selects it — ONE create pipeline, no second path
//      (W5-T1 / V34).
//   #3 a REAL viewport click selects the clicked object and a click on empty
//      space clears it (W5-T3 regression guard) — driven by projecting a box's
//      world position to canvas pixels and dispatching an actual mouse click, so
//      it observes the onClick raycast path (not the selection store directly).
//      Guards against the W1/W3 chrome OR the W4 home-mount path overlaying
//      something that swallows pointer events.
//
// Each test FIRST lands on the home (per-test init script removes the fixture's
// seeded lastProjectId — the H82 contract — then goto('/')), then opens
// example_starter. Mirrors the p6-w4-home pattern.
//
// REF: .planning/phases/v06.4-director-ux/PLAN.md WAVE W5 (W5-T1/T2/T3);
//      src/viewport/Viewport.tsx (empty hint), src/app/NPanel.tsx (empty body),
//      src/app/AddMenu.tsx (one addPrimitive pipeline),
//      src/viewport/SceneFromDAG.tsx:180 (onClick→select),
//      src/viewport/Viewport.tsx onPointerMissed (clear).

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';

interface DagNode {
  type: string;
}
interface BasherWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
  __basher_selection?: { getState: () => { selectedNodeId: string | null } };
  __basher_three?: {
    getState: () => {
      camera: {
        position: { clone: () => Vec3 };
        updateMatrixWorld: () => void;
        matrixWorldInverse: { copy: (m: unknown) => { invert: () => void } };
        matrixWorld: unknown;
      } | null;
    };
  };
}
interface Vec3 {
  set: (x: number, y: number, z: number) => Vec3;
  project: (camera: unknown) => Vec3;
  x: number;
  y: number;
}

const KEY = 'basher.lastProjectId';

/** Land on the HOME (true first run), then open the starter example. */
async function openStarterFromHome(page: Page): Promise<void> {
  await page.addInitScript((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage disabled */
    }
  }, KEY);
  await page.goto('/');
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-open-example_starter').click();
  await expect(page.getByTestId('layout')).toBeVisible();
  await expect(page.getByTestId('viewport').locator('canvas')).toHaveCount(1);
}

function selectedIdOf(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (window as unknown as BasherWindow).__basher_selection!.getState().selectedNodeId,
  );
}

test('P6-W5#1 empty-state hints show with no selection, clear once selected', async ({ page }) => {
  await openStarterFromHome(page);
  // Nothing is selected on open → both hints visible.
  expect(await selectedIdOf(page)).toBeNull();
  await expect(page.getByTestId('viewport-empty-hint')).toBeVisible();
  await expect(page.getByTestId('inspector-empty-hint')).toBeVisible();

  // Select a node → both hints disappear (the same no-selection condition).
  await page.evaluate(() => {
    (
      window as unknown as {
        __basher_selection: { getState: () => { select: (id: string) => void } };
      }
    ).__basher_selection
      .getState()
      .select('n_box');
  });
  await expect(page.getByTestId('viewport-empty-hint')).toHaveCount(0);
  await expect(page.getByTestId('inspector-empty-hint')).toHaveCount(0);
});

test('P6-W5#2 the visual ADD palette creates a real DAG node + auto-selects it', async ({
  page,
}) => {
  await openStarterFromHome(page);
  const before = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).length,
  );

  // Open the Add menu on the floating pill → Mesh ▸ Cube. ONE addPrimitive path.
  await page.getByTestId('top-toolbar-add').click();
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.getByTestId('add-menu-mesh').hover();
  await page.getByTestId('add-menu-item-Cube').click();

  const after = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag!.getState().state.nodes).length,
  );
  // #365 Slice 2: Add ▸ Cube is split-native — it builds TWO nodes, an `Object`
  // (pose) and its `BoxData` (geometry + material), so the count grows by 2.
  expect(after).toBe(before + 2);

  // Auto-selected, and the selected node is a REAL Op-built DAG node — the posable
  // `Object` half (V34 — every added object reduces to the one substrate, no second
  // pipeline).
  const selId = await selectedIdOf(page);
  expect(selId).not.toBeNull();
  const selType = await page.evaluate(
    (id) => (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes[id!].type,
    selId,
  );
  expect(selType).toBe('Object');
});

test('P6-W5#3 a real viewport click selects the object; clicking empty clears it', async ({
  page,
}) => {
  await openStarterFromHome(page);
  expect(await selectedIdOf(page)).toBeNull();

  // Wait for the editor camera to land in the threeRef seam (ThreeBridge writes
  // it once the Canvas renders), then project n_box's world position to canvas
  // pixels so we can dispatch a REAL click on the box.
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_three?.getState().camera != null,
  );
  const boxPt = await page.evaluate(() => {
    const w = window as unknown as BasherWindow & {
      __basher_mesh_world_position: (id: string) => [number, number, number] | null;
    };
    const cam = w.__basher_three!.getState().camera!;
    const pos = w.__basher_mesh_world_position('n_box');
    if (!pos) return null;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const v = cam.position.clone().set(pos[0], pos[1], pos[2]).project(cam);
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      top: r.top,
      cx: r.left + r.width / 2,
    };
  });
  expect(boxPt).not.toBeNull();

  // REAL click on the box → onClick raycast → selection set to its pickId.
  await page.mouse.click(boxPt!.x, boxPt!.y);
  await expect.poll(() => selectedIdOf(page)).toBe('n_box');
  await expect(page.getByTestId('viewport-empty-hint')).toHaveCount(0);

  // REAL click on empty sky → onPointerMissed → selection cleared, hints return.
  // Upper-center, BELOW the FloatingViewportToolbar buttons (which are NOT
  // pointer-events-none — #250 found top+28 sat over one, so the DOM click never
  // reached the canvas) and ABOVE the starter's boxes: a genuinely empty pixel.
  await page.mouse.click(boxPt!.cx, boxPt!.top + 140);
  await expect.poll(() => selectedIdOf(page)).toBeNull();
  await expect(page.getByTestId('viewport-empty-hint')).toBeVisible();
});

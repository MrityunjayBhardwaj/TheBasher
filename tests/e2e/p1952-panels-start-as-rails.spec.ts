// p1952 (#1952) — the side panels start as rails, so the viewport is the film from the first moment.
//
// Decided design (editor-design-v1: "The viewport is the film. Side panels start as rails"): on a
// first start the outliner and the inspector are slim rails (the chat column has the same kind of
// rail, #1704, though it starts open). A rail
// keeps its icon and opens on click; selecting an object does not open the inspector. The
// director's own choice is saved and wins on later starts, and the split / chat fold rules keep
// working on top (their own specs, p1709 and p1704, cover them with open panels; here: with rails).
//
// Done when: a fresh start shows both side panels as rails with the viewport filling the space
// between them; opening one and reloading keeps it open; the split and chat fold rules still pass.
//
// Read off the live surfaces: the islands' boxes and collapse attributes, the saved chrome record,
// the selection store, and a REAL viewport click projected from the object's world position.
//
// REF: src/app/stores/chromeStore.ts (DEFAULT_CHROME_STATE, chromeStateFromSaved);
//      src/app/LeftSidebar.tsx, src/app/NPanel.tsx (the rails); src/app/splitOutlinerFold.ts.
import type { Page } from '@playwright/test';
import { expect, settleViewFit, test } from './_fixtures';

test.setTimeout(120_000);

type Box = { x: number; y: number; width: number; height: number };

/** A first start: nothing saved for the chrome, the chat or the split. */
async function freshStart(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    for (const k of [
      'basher.chrome.v1',
      'basher.chatColumn.v1',
      'basher.splitView.v1',
      'basher.twoDView.v1',
    ]) {
      localStorage.removeItem(k);
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
}

async function box(page: Page, id: string): Promise<Box> {
  const b = await page.getByTestId(id).first().boundingBox();
  if (!b) throw new Error(`no box for ${id}`);
  return b;
}

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('basher.chrome.v1') ?? 'null') as unknown);

test('a fresh start shows both side panels as rails, the viewport filling the space between', async ({
  page,
}) => {
  await freshStart(page);
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  // Each rail keeps an icon that opens it.
  await expect(page.getByTestId('left-sidebar-expand-toggle').locator('svg')).toBeVisible();
  await expect(page.getByTestId('inspector-expand-toggle').locator('svg')).toBeVisible();
  // Nothing was chosen, so nothing was saved: the rails are the default, not a recorded choice.
  expect(await saved(page)).toBeNull();

  const vp = await box(page, 'viewport-slot');
  const tree = await box(page, 'tree-slot');
  const insp = await box(page, 'inspector-slot');
  expect(Math.round(tree.width), 'outliner rail').toBe(28);
  expect(Math.round(insp.width), 'inspector rail').toBe(28);
  // The clear picture between the two rails: everything but the rails and their gaps.
  const clear = insp.x - (tree.x + tree.width);
  expect(tree.x + tree.width - vp.x, 'the outliner rail hugs the left edge').toBeLessThan(48);
  expect(vp.x + vp.width - insp.x, 'the inspector rail hugs the right edge').toBeLessThan(48);
  expect(clear / vp.width, 'the viewport fills the space between them').toBeGreaterThan(0.9);

  await page.screenshot({
    path: test.info().outputPath('p1952-fresh-rails.png'),
  });
});

test('selecting an object does not open the inspector', async ({ page }) => {
  await freshStart(page);
  await settleViewFit(page);
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __basher_three?: { getState: () => { camera: unknown } } }
      ).__basher_three?.getState().camera != null,
  );
  // A REAL click on an object: project the first visible mesh's world position into the canvas.
  const target = await page.evaluate(() => {
    type V = { x: number; y: number; z: number };
    type Cam = {
      position: {
        clone: () => { set: (x: number, y: number, z: number) => { project: (c: Cam) => V } };
      };
      updateMatrixWorld: () => void;
      matrixWorld: { clone: () => unknown };
      matrixWorldInverse: { copy: (m: unknown) => { invert: () => void } };
    };
    const w = window as unknown as {
      __basher_three: { getState: () => { camera: Cam } };
      __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
      __basher_mesh_world_position: (id: string) => [number, number, number] | null;
    };
    const cam = w.__basher_three.getState().camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const canvas = document.querySelector('[data-testid="viewport"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    for (const [id, n] of Object.entries(w.__basher_dag.getState().state.nodes)) {
      if (n.type !== 'Object') continue;
      const pos = w.__basher_mesh_world_position(id);
      if (!pos) continue;
      const v = cam.position.clone().set(pos[0], pos[1], pos[2]).project(cam);
      if (Math.abs(v.x) > 0.6 || Math.abs(v.y) > 0.6) continue;
      return {
        id,
        x: r.left + (v.x * 0.5 + 0.5) * r.width,
        y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      };
    }
    return null;
  });
  expect(target, 'an object on screen to click').not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  const selected = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __basher_selection: { getState: () => { selectedNodeIds: Set<string> } };
      };
      return w.__basher_selection.getState().selectedNodeIds.size;
    });
  await expect.poll(selected, 'the click selected something').toBeGreaterThan(0);
  // Give any reaction to the selection a couple of frames to land, then read the rail.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  expect(Math.round((await box(page, 'inspector-slot')).width)).toBe(28);
});

test('opening a rail and reloading keeps it open; the other stays a rail', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('inspector-expand-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  expect(await saved(page)).toEqual({ inspectorCollapsed: false });
  await page.screenshot({
    path: test.info().outputPath('p1952-inspector-opened.png'),
  });

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  expect(Math.round((await box(page, 'inspector-slot')).width)).toBe(300);
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');

  // The outliner, the same way; and folding it again is remembered too.
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await page.getByTestId('left-sidebar-collapse-toggle').click();
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
});

test('the split leaves a first-start outliner rail as it found it, and an opened one is the director’s', async ({
  page,
}) => {
  await freshStart(page);
  const outliner = () => page.getByTestId('tree-slot').getAttribute('data-left-sidebar-collapsed');
  await page.getByTestId('space-switch-uv').click();
  await expect(page.getByTestId('view3d-slot')).toHaveAttribute('data-split', 'true');
  expect(await outliner(), 'a rail while split').toBe('true');
  await page.getByTestId('space-switch-view3d').click();
  // The split did not fold this rail, so it does not "restore" it open on the way out.
  await expect.poll(outliner, 'still a rail after the split').toBe('true');

  // Opened during the split, it is the director's: closing the split leaves it open.
  await page.getByTestId('space-switch-uv').click();
  await expect(page.getByTestId('view3d-slot')).toHaveAttribute('data-split', 'true');
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await expect.poll(outliner).toBe('false');
  await page.getByTestId('space-switch-view3d').click();
  await expect.poll(outliner, 'their choice stands').toBe('false');
});

test('chat at 1440 (it starts open): the inspector rail stays a rail; opening it folds chat, and back', async ({
  page,
}) => {
  await freshStart(page);
  // The chat column starts open (#1704) beside the inspector's first-start rail: the fold rule
  // reacts to transitions only, so neither moves on its own.
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
  // The director opens the rail: a user unfold, so chat folds to its rail.
  await page.getByTestId('inspector-expand-toggle').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'false');
  // And opening chat folds the inspector back to its rail.
  await page.getByTestId('chat-rail').click();
  await expect(page.getByTestId('agentdock-slot')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-collapsed', 'true');
});

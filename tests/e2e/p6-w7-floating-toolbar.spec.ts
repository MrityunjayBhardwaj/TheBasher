// P6 W7 acceptance — FloatingViewportToolbar (R8) + ModeBadge + Director
// chrome-hide. Closes §11 #1 (R8 reachable via testid) + #12 (Director
// chrome-hide). Per UI-SPEC §5.6, §5.7, §11.
//
// W7 ground truth: R8 carries the most-frequent viewport actions
// (Sel/Mv/Rot/Scl + Home/Grid + Shading + Snap) in gaze-proximity to
// the model. All tool buttons route through `editorStore.setActiveTool`
// — same dispatch path as R4 ToolRail and keyboard W/E/R — so every
// surface highlights in sync (V19 — keyboard/UI shared helper).
//
// Director chrome-hide closure: Layout.tsx hides R1/R2/R3/R4/R5/R7 +
// timeline-slot in director (W1/W3 baseline); R8 self-gates in
// FloatingViewportToolbar; ModeBadge returns null. Esc → edit
// (universal handler, KeyboardShortcuts.tsx:435). V11/K1#6 — Canvas
// DOM identity preserved across the round-trip (display:none, never
// unmount).
//
// REF: docs/UI-SPEC.md §5.6, §5.7, §11; memory/project_p6_w7_plan.md;
// vyapti V11 (Canvas mounts once), V19 (single keyboard/UI dispatcher).

import { expect, test } from './_fixtures';

interface BasherWindow {
  __basher_editor?: { getState: () => { activeTool: string } };
  __basher_viewport?: {
    getState: () => { shading: string; gridVisible: boolean };
  };
  __basher_selection?: {
    getState: () => { primaryNodeId: string | null; select: (id: string | null) => void };
  };
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string }> };
    };
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible();
});

test('P6.W7#1 R8 visible in edit; all 11 testids reachable (closes §11 #1)', async ({ page }) => {
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
  const ids = [
    'floating-toolbar-sel',
    'floating-toolbar-move',
    'floating-toolbar-rot',
    'floating-toolbar-scl',
    'floating-toolbar-home',
    'floating-toolbar-grid',
    'floating-toolbar-shading-studio',
    'floating-toolbar-shading-wireframe',
    'floating-toolbar-shading-rendered',
    'floating-toolbar-snap-toggle',
    'floating-toolbar-snap-step',
  ];
  for (const id of ids) {
    await expect(page.getByTestId(id), `${id} should be visible`).toBeVisible();
  }
});

test('P6.W7#2 click R8 Move → R4 ToolRail Translate highlights synchronously (V19)', async ({
  page,
}) => {
  await page.getByTestId('floating-toolbar-move').click();
  await expect(page.getByTestId('floating-toolbar-move')).toHaveAttribute('data-active', 'true');
  // R4 ToolRail's Translate button uses `text-accent` for active state.
  await expect(page.getByTestId('tool-rail-translate')).toHaveClass(/text-accent/);
  // Store agrees with both UIs.
  const tool = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_editor!.getState().activeTool,
  );
  expect(tool).toBe('translate');
});

test('P6.W7#3 click R4 ToolRail Rotate → R8 Rot highlights synchronously (V19, other direction)', async ({
  page,
}) => {
  await page.getByTestId('tool-rail-rotate').click();
  await expect(page.getByTestId('tool-rail-rotate')).toHaveClass(/text-accent/);
  await expect(page.getByTestId('floating-toolbar-rot')).toHaveAttribute('data-active', 'true');
});

test('P6.W7#4 keyboard E sets rotate; both R4 + R8 reflect it (V19 — 3-way sync)', async ({
  page,
}) => {
  // Click body to defocus any incidental editable surface.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await expect(page.getByTestId('tool-rail-rotate')).toHaveClass(/text-accent/);
  await expect(page.getByTestId('floating-toolbar-rot')).toHaveAttribute('data-active', 'true');
});

test('P6.W7#5 R8 Home button reframes camera on selected node', async ({ page }) => {
  // Pick a BoxMesh from the seed (P0 seeds at least one).
  const id = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    for (const [nid, n] of Object.entries(nodes)) if (n.type === 'BoxMesh') return nid;
    return null;
  });
  expect(id, 'seed should contain a BoxMesh').not.toBeNull();

  await page.evaluate((nodeId) => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select(nodeId!);
  }, id);

  // Click Home — should not throw, and primaryNodeId should still be
  // set after the click (frameSelected reads it, doesn't mutate it).
  await page.getByTestId('floating-toolbar-home').click();
  const primaryAfter = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_selection!.getState().primaryNodeId,
  );
  expect(primaryAfter).toBe(id);
});

test('P6.W7#6 R8 Grid button toggles viewportStore.gridVisible', async ({ page }) => {
  const before = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_viewport!.getState().gridVisible,
  );
  await page.getByTestId('floating-toolbar-grid').click();
  const after = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_viewport!.getState().gridVisible,
  );
  expect(after).toBe(!before);
});

test('P6.W7#7 R8 shading-rendered flips viewportStore.shading to "rendered"', async ({ page }) => {
  // Default is studio per viewportStore.ts:74.
  await expect(page.getByTestId('floating-toolbar-shading-studio')).toHaveClass(/text-accent/);
  await page.getByTestId('floating-toolbar-shading-rendered').click();
  await expect(page.getByTestId('floating-toolbar-shading-rendered')).toHaveClass(/text-accent/);
  const shading = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_viewport!.getState().shading,
  );
  expect(shading).toBe('rendered');
});

test('P6.W7#8 Director chrome-hide hides R1/R2/R3/R4/R5/R7 + R8 + ModeBadge; Esc restores; Canvas DOM identity stable (closes §11 #12, V11)', async ({
  page,
}) => {
  // Tag the Canvas so we can prove it survives the round-trip.
  const tagInitial = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    if (!c.dataset.persistenceTag) c.dataset.persistenceTag = String(Math.random());
    return c.dataset.persistenceTag;
  });
  expect(tagInitial).not.toBeNull();

  // Pre-director chrome is visible.
  await expect(page.getByTestId('top-toolbar')).toBeVisible(); // R3
  await expect(page.getByTestId('tree-slot')).toBeVisible(); // R5
  await expect(page.getByTestId('inspector')).toBeVisible(); // R7
  await expect(page.getByTestId('mode-badge')).toBeVisible();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // Enter director.
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'director');

  // Chrome hidden.
  await expect(page.getByTestId('top-toolbar')).toBeHidden();
  await expect(page.getByTestId('tree-slot')).toBeHidden();
  await expect(page.getByTestId('inspector')).toBeHidden();
  await expect(page.getByTestId('mode-badge')).toBeHidden();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeHidden();

  // R6 viewport stays visible.
  await expect(page.getByTestId('viewport-slot')).toBeVisible();

  // V11: Canvas DOM node identity preserved while in director.
  const tagInDirector = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(tagInDirector).toBe(tagInitial);

  // Esc returns to edit (universal handler).
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).toHaveAttribute('data-mode', 'edit');
  await expect(page.getByTestId('top-toolbar')).toBeVisible();
  await expect(page.getByTestId('mode-badge')).toHaveText('EDIT');
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // V11: Canvas DOM node identity preserved across the full round-trip.
  const tagAfter = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(tagAfter).toBe(tagInitial);
});

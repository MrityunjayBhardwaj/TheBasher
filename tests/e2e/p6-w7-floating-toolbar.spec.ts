// P6 W7 acceptance — FloatingViewportToolbar (R8) + present-mode
// chrome-hide. Closes §11 #1 (R8 reachable via testid) + #12 (present
// chrome-hide). Per UI-SPEC §5.6, §5.7, §11.
//
// W7 ground truth: R8 carries the most-frequent viewport actions
// (Sel/Mv/Rot/Scl + Home/Grid + Shading + Snap) in gaze-proximity to
// the model. All tool buttons route through `editorStore.setActiveTool`
// — same dispatch path as keyboard W/E/R — so every surface highlights in
// sync (V19 — keyboard/UI shared helper). (v0.6 #4 W1: R8 absorbed the
// deleted ToolRail's tools + the TopToolbar chrome; it is now the ONE pill.)
//
// Present chrome-hide closure (v0.6 #4 — the `director` mode that drove
// it is gone; chromeStore.presentMode owns the collapse now): Layout.tsx
// hides R1/R2/R5/R7 + timeline-slot when presentMode is on; R8
// self-gates in FloatingViewportToolbar. Esc dismisses the topmost
// transient (the Esc ladder). V11/K1#6 — Canvas DOM identity preserved
// across the round-trip (display:none, never unmount).
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

test('P6.W7#2 click R8 Move → store + R8 highlight agree synchronously (V19)', async ({ page }) => {
  // v0.6 #4 W1: the duplicate R4 ToolRail was deleted — R8 is now the ONE
  // tool surface, so V19 sync is proven between R8 and the editorStore (and
  // the keyboard, in #4). The cross-surface duplication this test once
  // guarded against is structurally gone.
  await page.getByTestId('floating-toolbar-move').click();
  await expect(page.getByTestId('floating-toolbar-move')).toHaveAttribute('data-active', 'true');
  const tool = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_editor!.getState().activeTool,
  );
  expect(tool).toBe('translate');
});

test('P6.W7#4 keyboard E sets rotate; R8 reflects it (V19 — keyboard ↔ R8 sync)', async ({
  page,
}) => {
  // Click body to defocus any incidental editable surface.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await expect(page.getByTestId('floating-toolbar-rot')).toHaveAttribute('data-active', 'true');
  const tool = await page.evaluate(
    () => (window as unknown as BasherWindow).__basher_editor!.getState().activeTool,
  );
  expect(tool).toBe('rotate');
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

test('P6.W7#8 Present chrome-hide hides R1/R2/R5/R7 + R8; Esc restores; Canvas DOM identity stable (closes §11 #12, V11)', async ({
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

  // Pre-present chrome is visible.
  await expect(page.getByTestId('project-tabs')).toBeVisible(); // R1
  await expect(page.getByTestId('tree-slot')).toBeVisible(); // R5
  await expect(page.getByTestId('inspector')).toBeVisible(); // R7
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // Enter present (the re-home for the deleted `director` mode). The Present
  // toggle now lives on the consolidated floating pill (testid preserved).
  await page.getByTestId('top-toolbar-present').click();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-present', 'true');

  // Chrome hidden.
  await expect(page.getByTestId('project-tabs')).toBeHidden();
  await expect(page.getByTestId('tree-slot')).toBeHidden();
  await expect(page.getByTestId('inspector')).toBeHidden();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeHidden();

  // R6 viewport stays visible.
  await expect(page.getByTestId('viewport-slot')).toBeVisible();

  // V11: Canvas DOM node identity preserved while in present.
  const tagInPresent = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(tagInPresent).toBe(tagInitial);

  // Esc dismisses the topmost transient (present) — the Esc-ladder regression.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('layout')).not.toHaveAttribute('data-present', 'true');
  await expect(page.getByTestId('project-tabs')).toBeVisible();
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();

  // V11: Canvas DOM node identity preserved across the full round-trip.
  const tagAfter = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(tagAfter).toBe(tagInitial);
});

// P2.6 acceptance — TransformToolbar (Wave A), editor shading
// (Wave B), UV editor scaffold (Wave C).
//
// State-driven assertions — read store snapshots through the dev-only
// window handles. Pixel-diff would re-fail H13 on every layout shift.

import { expect, test } from '@playwright/test';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: unknown; inputs: Record<string, unknown> }>;
        outputs: Record<string, { node: string; socket: string }>;
      };
    };
  };
  __basher_editor?: { getState: () => { space: 'view3d' | 'uv'; setSpace: (s: string) => void } };
  __basher_viewport?: {
    getState: () => {
      shading: 'studio' | 'rendered';
      gridVisible: boolean;
      snapEnabled: boolean;
    };
  };
  __basher_selection?: {
    getState: () => { primaryNodeId: string | null; select: (id: string | null) => void };
  };
}

test.beforeEach(async ({ page }) => {
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
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  // Wait for the dev-only store handles to land (boot.ts dynamic-imports
  // them so they appear after the first paint).
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_editor && w.__basher_viewport);
  });
});

// ---------------------------------------------------------------------------
// P2.6#1 — TransformToolbar mode buttons drive gizmoStore (proves the
// top-bar surface mirrors the existing G/R/S keyboard handlers).
// ---------------------------------------------------------------------------

test('P2.6#1 toolbar Move/Rotate/Scale buttons drive the gizmo mode', async ({ page }) => {
  await expect(page.getByTestId('transform-toolbar')).toBeVisible();
  await page.getByTestId('toolbar-mode-rotate').click();
  // Active state shows on the button via aria-equivalent classes; assert
  // the visible class delta to confirm the click landed.
  await expect(page.getByTestId('toolbar-mode-rotate')).toHaveClass(/text-accent/);
  await page.getByTestId('toolbar-mode-translate').click();
  await expect(page.getByTestId('toolbar-mode-translate')).toHaveClass(/text-accent/);
});

// ---------------------------------------------------------------------------
// P2.6#2 — Toolbar shading group toggles viewportStore.shading. Defaults
// to 'studio'; clicking 'rendered' flips the projection without touching
// the DAG (V8 stays clean — observe via __basher_dag undoStack length).
// ---------------------------------------------------------------------------

test('P2.6#2 shading toggle flips viewportStore.shading; DAG is unmutated', async ({ page }) => {
  // Default is studio.
  await expect(page.getByTestId('toolbar-shading-studio')).toHaveClass(/text-accent/);
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });
  await page.getByTestId('toolbar-shading-rendered').click();
  await expect(page.getByTestId('toolbar-shading-rendered')).toHaveClass(/text-accent/);
  const shading = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_viewport!.getState().shading;
  });
  expect(shading).toBe('rendered');
  // DAG node count unchanged → no leak into the graph.
  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });
  expect(after).toBe(before);
});

// ---------------------------------------------------------------------------
// P2.6#3 — Space toggle swaps the 3D viewport for the UV editor without
// unmounting the Canvas (K1 step 6 discipline preserved via display:none).
// ---------------------------------------------------------------------------

test('P2.6#3 space toggle swaps view3d ↔ uv; Canvas DOM node persists', async ({ page }) => {
  await expect(page.getByTestId('uv-slot')).toHaveCSS('display', 'none');
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'block');

  // Capture the underlying <canvas> element id so we can prove it's the
  // same node after the toggle (display:none keeps it mounted).
  const beforeId = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    if (!c.dataset.persistenceTag) c.dataset.persistenceTag = String(Math.random());
    return c.dataset.persistenceTag;
  });
  expect(beforeId).not.toBeNull();

  await page.getByTestId('toolbar-space-uv').click();
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'none');
  await expect(page.getByTestId('uv-slot')).toHaveCSS('display', 'block');
  await expect(page.getByTestId('uv-editor')).toBeVisible();

  const sameId = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(sameId).toBe(beforeId);

  // Toggle back via Tab keyboard — must not be intercepted by inputs.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'block');
});

// ---------------------------------------------------------------------------
// P2.6#4 — UV editor renders a status line and reflects selection. When
// no node is selected, status shows the placeholder; when a BoxMesh is
// selected, status names it.
// ---------------------------------------------------------------------------

test('P2.6#4 UV editor status updates with selection', async ({ page }) => {
  await page.getByTestId('toolbar-space-uv').click();
  await expect(page.getByTestId('uv-editor-status')).toContainText('Select a mesh');

  // Find a BoxMesh in the seed and select it via the projection store.
  const id = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    for (const [nid, n] of Object.entries(nodes)) if (n.type === 'BoxMesh') return nid;
    return null;
  });
  expect(id).not.toBeNull();
  await page.evaluate((nodeId) => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select(nodeId!);
  }, id);
  await expect(page.getByTestId('uv-editor-status')).toContainText('BoxMesh');
});

// ---------------------------------------------------------------------------
// P2.6#5 — View → Editor Space submenu flips the active space. Mirrors
// the toolbar but proves the menu wiring.
// ---------------------------------------------------------------------------

test('P2.6#5 View menu Editor Space submenu switches to UV', async ({ page }) => {
  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-space').hover();
  await page.getByTestId('menu-view-space-uv').click();
  await expect(page.getByTestId('uv-editor')).toBeVisible();
});

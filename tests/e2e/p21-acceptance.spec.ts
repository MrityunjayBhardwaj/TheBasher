// P2.1 acceptance — viewport polish (Wave A+B+C) + menu bar (Wave D).
//
// Honesty contract from CLAUDE.md / NEXT_SESSION.md: state-driven assertions,
// no pixel-diff (H8). Where we'd normally drive a UI gesture, we drive the
// underlying production code path through __basher_dag (H3 lesson).

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: unknown; inputs: Record<string, unknown> }>;
        outputs: Record<string, { node: string; socket: string }>;
      };
      undoStack: unknown[];
      redoStack: unknown[];
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => void;
      dispatch: (op: unknown, source?: string, description?: string) => void;
      undo: () => unknown;
    };
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
  await page.waitForFunction(() => {
    const w = window as unknown as DagWindow;
    return Boolean(w.__basher_dag);
  });
});

// ---------------------------------------------------------------------------
// P2.1#1 — Cmd+Z keyboard shortcut reverts the last Op (proves the global
// listener is alive and routes through the dispatcher).
// ---------------------------------------------------------------------------

test('P2.1#1 Cmd+Z reverts the last Op via the global keyboard listener', async ({ page }) => {
  // Pick a known scalar param on the seed scene's first node and mutate it
  // through the Op system, then issue a real keyboard Cmd+Z.
  const before = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    // Seed scene has a BoxMesh at id 'box1' with a scalar param the seed
    // ships. Find any node with a numeric `size` triple to mutate.
    for (const [id, node] of Object.entries(dag.state.nodes)) {
      const params = node.params as Record<string, unknown>;
      if (Array.isArray(params.size)) {
        return { id, originalSize: [...(params.size as number[])] };
      }
    }
    return null;
  });
  test.skip(!before, 'seed project lacks a BoxMesh-shaped param to mutate');

  await page.evaluate((id) => {
    const w = window as unknown as DagWindow;
    w.__basher_dag!.getState().dispatch(
      { type: 'setParam', nodeId: id, paramPath: 'size', value: [9, 9, 9] },
      'user',
      'p21#1 mutate',
    );
  }, before!.id);

  // Real keystroke through the page so KeyboardShortcuts.tsx runs.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+z');

  const after = await page.evaluate((id) => {
    const w = window as unknown as DagWindow;
    return (w.__basher_dag!.getState().state.nodes[id].params as { size: number[] }).size;
  }, before!.id);
  expect(after).toEqual(before!.originalSize);
});

// ---------------------------------------------------------------------------
// P2.1#2 — Cmd+Shift+C bakes a new PerspectiveCamera node and reroutes
// scene.camera atomically. One Cmd+Z reverts the snapshot.
// ---------------------------------------------------------------------------

test('P2.1#2 Cmd+Shift+C bakes a new PerspectiveCamera + reroutes scene.camera', async ({
  page,
}) => {
  const before = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState().state;
    const sceneRef = s.outputs.scene;
    const sceneNode = s.nodes[sceneRef.node];
    const camInput = sceneNode.inputs.camera as { node: string; socket: string };
    return {
      nodeCount: Object.keys(s.nodes).length,
      cameraId: camInput.node,
    };
  });

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Meta+Shift+c');

  const after = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState().state;
    const sceneRef = s.outputs.scene;
    const sceneNode = s.nodes[sceneRef.node];
    const camInput = sceneNode.inputs.camera as { node: string; socket: string };
    const newCam = s.nodes[camInput.node];
    return {
      nodeCount: Object.keys(s.nodes).length,
      cameraId: camInput.node,
      cameraType: newCam?.type,
      undoLen: w.__basher_dag!.getState().undoStack.length,
    };
  });

  expect(after.nodeCount).toBe(before.nodeCount + 1);
  expect(after.cameraId).not.toBe(before.cameraId);
  expect(after.cameraType).toBe('PerspectiveCamera');
  expect(after.undoLen).toBeGreaterThan(0);

  // One undo reverts the entire atomic group → camera input restored.
  await page.evaluate(() => (window as unknown as DagWindow).__basher_dag!.getState().undo());
  const reverted = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState().state;
    const camInput = s.nodes[s.outputs.scene.node].inputs.camera as {
      node: string;
    };
    return {
      nodeCount: Object.keys(s.nodes).length,
      cameraId: camInput.node,
    };
  });
  expect(reverted.nodeCount).toBe(before.nodeCount);
  expect(reverted.cameraId).toBe(before.cameraId);
});

// ---------------------------------------------------------------------------
// P2.1#3 — Menu bar opens; File / Edit / Select / View popovers each render
// their items. Reset-to-Default is gated by a confirm dialog (handled).
// ---------------------------------------------------------------------------

test('P2.1#3 menu bar opens File/Edit/Select/View; items render', async ({ page }) => {
  await expect(page.getByTestId('menubar')).toBeVisible();

  for (const menu of ['file', 'edit', 'select', 'view']) {
    await page.getByTestId(`menu-${menu}-button`).click();
    await expect(page.getByTestId(`menu-${menu}-panel`)).toBeVisible();
    // Click the button again to close, so the next menu can open cleanly
    // (single-open contract in MenuBar.tsx).
    await page.getByTestId(`menu-${menu}-button`).click();
  }

  // File → Save fires the existing save flow without throwing. We assert
  // the panel closes (proves the click resolved); the Chrome save indicator
  // is owned by the Chrome button, not the menu, so we don't probe it here.
  await page.getByTestId('menu-file-button').click();
  await page.getByTestId('menu-file-save').click();
  await expect(page.getByTestId('menu-file-panel')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// P2.1#4 — View → Toggle Grid + Toggle Axis flips the corresponding
// viewportStore flag (read via the NPanel toggle's own visual state since
// stores aren't exposed to E2E directly).
// ---------------------------------------------------------------------------

test('P2.1#4 View → Toggle Grid flips viewportStore.gridVisible', async ({ page }) => {
  // P6 W2.6 — NPanel was rebuilt as the canonical Inspector; its
  // viewport-toggles section (grid / axis show-hide) was deleted in
  // favor of W7's FloatingViewportToolbar. Until W7 lands, verify the
  // menu's toggle-grid path via viewportStore directly — the menu
  // still flips the underlying state; only the UI mirror moved.
  await page.waitForFunction(() => {
    type Win = { __basher_viewport?: unknown };
    return Boolean((window as unknown as Win).__basher_viewport);
  });
  const before = await page.evaluate(() => {
    type Win = { __basher_viewport?: { getState: () => { gridVisible: boolean } } };
    return (window as unknown as Win).__basher_viewport!.getState().gridVisible;
  });

  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-toggle-grid').click();

  const after = await page.evaluate(() => {
    type Win = { __basher_viewport?: { getState: () => { gridVisible: boolean } } };
    return (window as unknown as Win).__basher_viewport!.getState().gridVisible;
  });
  expect(after).not.toBe(before);
});

// ---------------------------------------------------------------------------
// P2.1#5 — Click-to-select fires the selection store. We drive the same
// path the production R3F handler invokes (selectionStore.select) — pointer
// events on R3F primitives are tested in unit tests; the E2E proves the
// store's public surface continues to land on the Inspector.
// ---------------------------------------------------------------------------

test('P2.1#5 SceneTree click selects → Inspector renders that node', async ({ page }) => {
  // Pick a scene-tree node id (sorted first is n_box, which is the
  // BoxMesh living under scene's children — guaranteed to render as a
  // scene-tree row). P6 W2.5 dropped the flat NodeList; the same
  // selection path now goes through the SceneTree testid.
  const id = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).sort()[0];
  });

  // P6 W2.6 — SceneTree default-collapsed; expand via dev seam so the
  // tree row is reachable for the click.
  await page.waitForFunction(() => {
    type Win = { __basher_chrome?: unknown };
    return Boolean((window as unknown as Win).__basher_chrome);
  });
  await page.evaluate(() => {
    type Win = {
      __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
    };
    (window as unknown as Win).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });

  // Inspector starts on the empty-state placeholder (v0.6 #4 W5 enriched the
  // copy from "select a node" → first-run guidance; still non-interactive).
  await expect(page.getByTestId('inspector')).toContainText('No selection');
  await page.getByTestId(`scene-tree-row-${id}`).click();
  // The Inspector header renders the selected node id once selection lands.
  await expect(page.getByTestId('inspector')).toContainText(id);
});

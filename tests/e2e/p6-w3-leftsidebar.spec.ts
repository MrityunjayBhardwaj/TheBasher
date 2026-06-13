// P6 W3 acceptance — ProjectTabs (R1) + LeftSidebar (R5) + ComfyStatusIndicator
// migration + AddMenu both-paths regression.
//
// Coverage anchored to UI-SPEC §11 #1 partial (R1 + R5 reachable) +
// §11 #11 (ProjectTabs unsaved indicator + tooltip) + §5.1 + §5.5 +
// §5.10 + D-01/D-02/D-03/D-04 locked.
//
// REF: docs/UI-SPEC.md §5.1, §5.5, §5.10, §11.

import { expect, test } from './_fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Clean persistence so first-visit defaults apply per test (D-01).
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        // ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('basher.leftSidebar.v1');
      localStorage.removeItem('basher.chrome.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  // Wait for the chromeStore dev seam to land so we can drive
  // collapse state programmatically (the SceneTree default-collapsed
  // pattern from W2.6).
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
  // Expand the left sidebar so the tab strip is reachable in tests
  // that exercise tabs. Collapse-specific test re-collapses as needed.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: {
        getState: () => { setLeftSidebarCollapsed: (b: boolean) => void };
      };
    };
    w.__basher_chrome.getState().setLeftSidebarCollapsed(false);
  });
});

test('P6.W3#1 left panel: header + Outliner|Assets tabs; Outliner has search + Scenes + tree (UX #6)', async ({
  page,
}) => {
  // UX backlog #6: the left panel is a two-tab surface (Outliner | Assets).
  // The Outliner tab (default) holds search + Scenes label + the tree; the
  // old footer (Library/Import/Help) is gone — Library is the Assets tab,
  // Import is the Assets-tab button, Help & Feedback was dropped.
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('left-sidebar-header')).toBeVisible();
  // Tab strip.
  await expect(page.getByTestId('left-sidebar-tabstrip')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-tab-outliner')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-tab-assets')).toBeVisible();
  // Outliner tab content (default).
  await expect(page.getByTestId('left-sidebar-search')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-scenes-label')).toBeVisible();
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  // The dropped footer + its links no longer exist.
  await expect(page.getByTestId('left-sidebar-footer')).toHaveCount(0);
  await expect(page.getByTestId('left-sidebar-library')).toHaveCount(0);
  await expect(page.getByTestId('left-sidebar-help')).toHaveCount(0);
  // The old Scene|Agent tab scheme is gone.
  await expect(page.getByTestId('left-sidebar-tab-scene')).toHaveCount(0);
  await expect(page.getByTestId('left-sidebar-tab-agent')).toHaveCount(0);
});

test('P6.W3#1b the Assets tab hosts the library + Import (UX #6)', async ({ page }) => {
  await page.getByTestId('left-sidebar-tab-assets').click();
  await expect(page.getByTestId('left-sidebar-assets-panel')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-import')).toBeVisible();
  await expect(page.getByTestId('library-popover')).toBeVisible();
});

test('P6.W3#2 outliner search filters the tree (Wave B)', async ({ page }) => {
  // The seed project's box is visible unfiltered.
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  // A non-matching query hides it and shows the empty-state hint.
  await page.getByTestId('left-sidebar-search').fill('zzz-no-such-object');
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeHidden();
  await expect(page.getByTestId('scene-tree-no-matches')).toBeVisible();
  // A matching query surfaces it again (the Scene root is the only other row).
  await page.getByTestId('left-sidebar-search').fill('box');
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
  await expect(page.getByTestId('scene-tree-no-matches')).toHaveCount(0);
  // Clearing the search restores the full tree.
  await page.getByTestId('left-sidebar-search').fill('');
  await expect(page.getByTestId('scene-tree-row-n_scene')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-n_box')).toBeVisible();
});

test('P6.W3#3 collapse chevron lives in the outliner header (V35 reveal stays reachable)', async ({
  page,
}) => {
  // From the always-on expanded state.
  await expect(page.getByTestId('left-sidebar-collapse-toggle')).toBeVisible();
  await page.getByTestId('left-sidebar-collapse-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  // Collapsed: only the expand chevron strip; the outliner body is gone.
  await expect(page.getByTestId('left-sidebar-expand-toggle')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-search')).toHaveCount(0);
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('left-sidebar-search')).toBeVisible();
});

test('P6.W3#5 ProjectTabs unsaved indicator dot appears after a dispatch, clears after save', async ({
  page,
}) => {
  // Wait for the boot subscription to be registered (dirty starts false).
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __basher_dag?: unknown;
    };
    return Boolean(w.__basher_dag);
  });
  // No dot initially — fresh project, no edits.
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);

  // Dispatch a synthetic param change so the boot dispatcher subscription
  // flips dirty=true. Picks any node from the seed DAG.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
          dispatchAtomic: (ops: unknown[], source: string, description: string) => void;
        };
      };
    };
    const dag = w.__basher_dag.getState();
    // Find a BoxMesh from the seed.
    const node = Object.values(dag.state.nodes).find((n) => n.type === 'BoxMesh');
    if (!node) throw new Error('seed project missing BoxMesh');
    const nodeId = Object.keys(dag.state.nodes).find((k) => dag.state.nodes[k] === node);
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId, paramPath: 'position', value: [1, 0, 0] }],
      'user',
      'e2e dirty probe',
    );
  });

  // Dot should now be visible on the active project's tab.
  await expect(page.getByTestId('project-tab-dirty-dot')).toBeVisible();

  // Save and verify dot clears.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
});

test('P6.W3#6 AddMenu reachable from RMB and toolbar + button (D-04 regression)', async ({
  page,
}) => {
  // Path 1 — RMB on viewport.
  const viewport = page.getByTestId('viewport-slot');
  await viewport.click({ button: 'right', position: { x: 200, y: 200 } });
  await expect(page.getByTestId('add-menu')).toBeVisible();
  // Close via Escape (existing handler) and confirm.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toHaveCount(0);

  // Path 2 — toolbar + button.
  await page.getByTestId('top-toolbar-add').click();
  await expect(page.getByTestId('add-menu')).toBeVisible();
  // Sanity: contains at least one mesh group.
  await expect(page.getByTestId('add-menu-mesh')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toHaveCount(0);
});

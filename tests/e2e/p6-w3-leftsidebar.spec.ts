// P6 W3 acceptance — ProjectTabs (R1) + LeftSidebar (R5) + ComfyStatusIndicator
// migration + AddMenu both-paths regression.
//
// Coverage anchored to UI-SPEC §11 #1 partial (R1 + R5 reachable) +
// §11 #11 (ProjectTabs unsaved indicator + tooltip) + §5.1 + §5.5 +
// §5.10 + D-01/D-02/D-03/D-04 locked.
//
// REF: docs/UI-SPEC.md §5.1, §5.5, §5.10, §11.

import { expect, test } from '@playwright/test';

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
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
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

test('P6.W3#1 LeftSidebar default activeTab = scene (D-01)', async ({ page }) => {
  // Wait for the dev seam.
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_left_sidebar?: unknown }).__basher_left_sidebar),
  );
  const tab = await page.evaluate(() => {
    const w = window as unknown as {
      __basher_left_sidebar: { getState: () => { activeTab: string } };
    };
    return w.__basher_left_sidebar.getState().activeTab;
  });
  expect(tab).toBe('scene');
  await expect(page.getByTestId('left-sidebar-tab-scene')).toHaveAttribute('data-active', 'true');
});

test('P6.W3#2 tab switch routes through leftSidebarStore + survives reload', async ({ page }) => {
  await page.getByTestId('left-sidebar-tab-agent').click();
  // Active tab is now Agent.
  await expect(page.getByTestId('left-sidebar-tab-agent')).toHaveAttribute('data-active', 'true');
  // Scene body is hidden via display:none (still in DOM).
  const sceneBodyDisplay = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="left-sidebar-body-scene"]');
    return el ? getComputedStyle(el as HTMLElement).display : null;
  });
  expect(sceneBodyDisplay).toBe('none');

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_left_sidebar?: unknown }).__basher_left_sidebar),
  );
  // Re-expand chrome so the tab strip is visible after the reload-time
  // collapse default. The persisted activeTab survives independently.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: { getState: () => { setLeftSidebarCollapsed: (b: boolean) => void } };
    };
    w.__basher_chrome.getState().setLeftSidebarCollapsed(false);
  });
  const persistedTab = await page.evaluate(() => {
    const w = window as unknown as {
      __basher_left_sidebar: { getState: () => { activeTab: string } };
    };
    return w.__basher_left_sidebar.getState().activeTab;
  });
  expect(persistedTab).toBe('agent');
});

test('P6.W3#3 LeftSidebar collapse chevron lives in the tab strip (D-03)', async ({ page }) => {
  // From expanded state (beforeEach already expanded).
  await expect(page.getByTestId('left-sidebar-collapse-toggle')).toBeVisible();
  await page.getByTestId('left-sidebar-collapse-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('left-sidebar-expand-toggle')).toBeVisible();
  // The tab strip is hidden when collapsed — only the expand chevron strip.
  await expect(page.getByTestId('left-sidebar-tab-strip')).toBeHidden();
  await page.getByTestId('left-sidebar-expand-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByTestId('left-sidebar-tab-strip')).toBeVisible();
});

test('P6.W3#4 ComfyStatusIndicator migrated from Chrome to ProjectTabs right edge', async ({ page }) => {
  // Lives inside ProjectTabs (R1)…
  const inProjectTabs = await page.evaluate(() => {
    const indicator = document.querySelector('[data-testid="comfy-status-indicator"]');
    const tabs = document.querySelector('[data-testid="project-tabs"]');
    return Boolean(indicator && tabs && tabs.contains(indicator));
  });
  expect(inProjectTabs).toBe(true);
  // …and NOT inside Chrome (R2 — the W2 temporary home is now empty of it).
  const inChrome = await page.evaluate(() => {
    const indicator = document.querySelector('[data-testid="comfy-status-indicator"]');
    const chrome = document.querySelector('[data-testid="chrome"]');
    return Boolean(indicator && chrome && chrome.contains(indicator));
  });
  expect(inChrome).toBe(false);
});

test('P6.W3#5 ProjectTabs unsaved indicator dot appears after a dispatch, clears after save', async ({ page }) => {
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
          dispatchAtomic: (
            ops: unknown[],
            source: string,
            description: string,
          ) => void;
        };
      };
    };
    const dag = w.__basher_dag.getState();
    // Find a BoxMesh from the seed.
    const node = Object.values(dag.state.nodes).find((n) => n.type === 'BoxMesh');
    if (!node) throw new Error('seed project missing BoxMesh');
    const nodeId = Object.keys(dag.state.nodes).find(
      (k) => dag.state.nodes[k] === node,
    );
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId, paramPath: 'position', value: [1, 0, 0] }],
      'user',
      'e2e dirty probe',
    );
  });

  // Dot should now be visible on the active project's tab.
  await expect(page.getByTestId('project-tab-dirty-dot')).toBeVisible();

  // Save and verify dot clears.
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);
});

test('P6.W3#6 AddMenu reachable from RMB and toolbar + button (D-04 regression)', async ({ page }) => {
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

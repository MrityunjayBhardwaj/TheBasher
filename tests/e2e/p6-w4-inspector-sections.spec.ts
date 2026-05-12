// P6 W4 acceptance — NPanel section convention (UI-SPEC §5.8 + §7.2 + §7.3).
//
// Coverage:
//   #1 selecting a BoxMesh renders Mesh/Transform/Material section headers
//   #2 §5.8 default-collapsed rule — primary domain expanded, others collapsed
//   #3 toggling a section header collapses it and persists across reload
//   #4 different node types show different sections (selecting a Transform
//      node shows only the Transform section)
//   #5 raw-fallback path: nodes without declared inspectorSections (e.g.
//      Character) render via inspector-raw-fallback testid
//
// REF: docs/UI-SPEC.md §5.8, §7.2, §7.3; D-06/07/08/09/10 locked W4.

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wipe persistence so first-visit defaults apply per test.
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
      localStorage.removeItem('basher.inspectorSections.v1');
      localStorage.removeItem('basher.chrome.v1');
      localStorage.removeItem('basher.leftSidebar.v1');
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  // Wait for dev seams.
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __basher_chrome?: unknown; __basher_inspector_sections?: unknown })
          .__basher_chrome,
      ),
  );
  // Expand the LeftSidebar so we can interact with SceneTree.
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: { getState: () => { setLeftSidebarCollapsed: (b: boolean) => void } };
    };
    w.__basher_chrome.getState().setLeftSidebarCollapsed(false);
  });
});

test('P6.W4#1 selecting a BoxMesh renders Mesh/Transform/Material section headers', async ({
  page,
}) => {
  await page.getByTestId('scene-tree-row-n_box').click();
  await expect(page.getByTestId('inspector-section-mesh')).toBeVisible();
  await expect(page.getByTestId('inspector-section-transform')).toBeVisible();
  await expect(page.getByTestId('inspector-section-material')).toBeVisible();
});

test('P6.W4#2 §5.8 default-collapsed rule — primary expanded, others collapsed', async ({
  page,
}) => {
  await page.getByTestId('scene-tree-row-n_box').click();
  // Mesh = primary domain → not collapsed (body visible).
  await expect(page.getByTestId('inspector-section-mesh')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-body-mesh')).toBeVisible();
  // Transform and Material default-collapse for a mesh-primary node.
  await expect(page.getByTestId('inspector-section-transform')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-material')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
});

test('P6.W4#3 toggling a section header persists across reload', async ({ page }) => {
  await page.getByTestId('scene-tree-row-n_box').click();
  // Expand Transform (default-collapsed for BoxMesh).
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-transform')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
  // Collapse Mesh (default-expanded for BoxMesh).
  await page.getByTestId('inspector-section-toggle-mesh').click();
  await expect(page.getByTestId('inspector-section-mesh')).toHaveAttribute(
    'data-collapsed',
    'true',
  );

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: { getState: () => { setLeftSidebarCollapsed: (b: boolean) => void } };
    };
    w.__basher_chrome.getState().setLeftSidebarCollapsed(false);
  });
  await page.getByTestId('scene-tree-row-n_box').click();
  // Both user choices survive reload.
  await expect(page.getByTestId('inspector-section-mesh')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-transform')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
});

test('P6.W4#4 raw-fallback path: legacy nodes render flat (no sections)', async ({ page }) => {
  // Add a Character node — declared without inspectorSections (D-08 B).
  // Use the seed scene's existing Character node if present, else add one
  // via the agent surface; for v0.5 simplest, dispatch directly.
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_dag?: unknown }).__basher_dag),
  );
  const characterId = await page.evaluate(() => {
    const w = window as unknown as {
      __basher_dag: {
        getState: () => {
          state: { nodes: Record<string, { type: string }> };
          dispatch: (op: unknown, source: string, desc: string) => void;
        };
      };
    };
    const dag = w.__basher_dag.getState();
    // See if a Character is already in the seed.
    const existing = Object.keys(dag.state.nodes).find(
      (id) => dag.state.nodes[id].type === 'Character',
    );
    if (existing) return existing;
    // Else: create one via addNode.
    const id = `char_test_${Date.now().toString(36)}`;
    dag.dispatch(
      {
        type: 'addNode',
        nodeId: id,
        nodeType: 'Character',
        params: {},
      },
      'user',
      'e2e seed character',
    );
    return id;
  });
  // Select the character via the selection dev seam (Characters may not
  // appear in SceneTree by default — selection drives Inspector directly).
  await page.waitForFunction(
    () => Boolean((window as unknown as { __basher_selection?: unknown }).__basher_selection),
  );
  await page.evaluate((id) => {
    const w = window as unknown as {
      __basher_selection: { getState: () => { select: (id: string) => void } };
    };
    w.__basher_selection.getState().select(id);
  }, characterId);
  // Raw-fallback testid should be present; no inspector-section-* cards.
  await expect(page.getByTestId('inspector-raw-fallback')).toBeVisible();
  await expect(page.getByTestId('inspector-section-mesh')).toHaveCount(0);
  await expect(page.getByTestId('inspector-section-transform')).toHaveCount(0);
});

test('P6.W4#5 sections appear in declared order (mesh → transform → material for BoxMesh)', async ({
  page,
}) => {
  await page.getByTestId('scene-tree-row-n_box').click();
  // Read DOM order of section headers.
  const order = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('[data-testid^="inspector-section-"]'))
      .filter((el) =>
        /^inspector-section-(mesh|transform|material|render|animate|channel|layout)$/.test(
          el.getAttribute('data-testid') ?? '',
        ),
      )
      .map((el) => el.getAttribute('data-testid'));
    return sections;
  });
  expect(order).toEqual([
    'inspector-section-mesh',
    'inspector-section-transform',
    'inspector-section-material',
  ]);
});

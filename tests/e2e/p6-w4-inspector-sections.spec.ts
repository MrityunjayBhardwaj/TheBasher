// P6 W4 acceptance — NPanel section convention (UI-SPEC §5.8 + §7.2 + §7.3).
//
// Coverage:
//   #1 selecting a split cube renders Mesh/Transform/Material section headers
//   #2 §5.8 default-collapsed rule — primary domain expanded, others collapsed
//   #3 toggling a section header collapses it and persists across reload
//   #4 different node types show different sections (selecting a Transform
//      node shows only the Transform section)
//   #5 raw-fallback path: nodes without declared inspectorSections (e.g.
//      Character) render via inspector-raw-fallback testid
//
// REF: docs/UI-SPEC.md §5.8, §7.2, §7.3; D-06/07/08/09/10 locked W4.

import { expect, test } from './_fixtures';

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
  await page.waitForFunction(() =>
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

// #365 Phase 5a (Slice 1b/1c) — the seed box is a split Object now: Transform is the Object's
// own section, Mesh + Material come from the linked BoxData.
//
// #471 B-III — WHY #2/#3/#5 CHANGED SUBJECT. They used to add a fused `SphereMesh` and drive
// that, to pin the section machinery on a single node owning geometry + transform + material
// without coupling to the split's two-block layout. `SphereMesh` retired at #384 and its
// `evaluate` has been a throwing sentinel since, so the spec was asserting on a shape the
// product can no longer build — the silent case the retire-a-kind gate now catches
// (src/test-utils/retiredKinds.gate.test.ts).
//
// The fix is not a stand-in with the old shape, because that shape is what Stage C RETIRED.
// The only surviving node still declaring mesh+transform+material together is `BakedMesh`, a
// bake target whose `geometry` and 14-field `material` params are both required — a twenty-line
// fixture standing in for something a user never selects. So these tests move to the shape a
// user DOES select: the split pair, via the seed box, constructing nothing at all.
//
// That keeps every claim and adds one the fused version could not make. §5.8 ("the primary
// domain is expanded, the rest collapse") is now observed to hold PER NODE, each block against
// its OWN declared list: the Object's ['transform','constraint','driver','modifier'] expands
// transform, and the linked BoxData's ['mesh','material'] independently expands mesh. A single
// fused node cannot distinguish "the rule is applied per node" from "the rule is applied once
// to whatever is on screen"; two blocks can.
async function selectSeedBox(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('scene-tree-row-n_box').click();
  await expect(page.getByTestId('inspector-section-transform')).toBeVisible();
}

test('P6.W4#1 selecting a split cube renders Mesh/Transform/Material section headers (linked-data reach)', async ({
  page,
}) => {
  // The seed box is a split Object: Transform is its own section, Mesh + Material come from the
  // linked BoxData (the Slice 1c reach). All three headers must be visible.
  await page.getByTestId('scene-tree-row-n_box').click();
  await expect(page.getByTestId('inspector-section-mesh')).toBeVisible();
  await expect(page.getByTestId('inspector-section-transform')).toBeVisible();
  await expect(page.getByTestId('inspector-section-material')).toBeVisible();
  // The linked-data region is what surfaces Mesh + Material for the Object.
  await expect(page.getByTestId('inspector-linked-data')).toBeVisible();
});

test('P6.W4#2 §5.8 default-collapsed rule — each block’s primary expanded, others collapsed', async ({
  page,
}) => {
  await selectSeedBox(page);

  // The Object's own list is ['transform','constraint','driver','modifier'] → transform is its
  // primary domain and expands; the other three collapse.
  await expect(page.getByTestId('inspector-section-transform')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
  for (const id of ['constraint', 'driver', 'modifier']) {
    await expect(page.getByTestId(`inspector-section-${id}`)).toHaveAttribute(
      'data-collapsed',
      'true',
    );
  }

  // The linked BoxData's list is ['mesh','material'] → mesh is ITS primary and expands even
  // though it is not the Object's. This is the per-node half of the rule: if collapse were
  // computed once for the whole panel, mesh would arrive collapsed behind transform.
  await expect(page.getByTestId('inspector-section-mesh')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-body-mesh')).toBeVisible();
  await expect(page.getByTestId('inspector-section-material')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
});

test('P6.W4#3 toggling a section header persists across reload', async ({ page }) => {
  await selectSeedBox(page);
  // Both toggles move a section AWAY from its default, so a collapse state that silently reset
  // on reload could not be mistaken for the default one. Transform defaults EXPANDED (the
  // Object's primary) → collapse it; Material defaults COLLAPSED (not BoxData's primary) →
  // expand it. One toggle per block, so the assertion also covers the linked half.
  await page.getByTestId('inspector-section-toggle-transform').click();
  await expect(page.getByTestId('inspector-section-transform')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await page.getByTestId('inspector-section-toggle-material').click();
  await expect(page.getByTestId('inspector-section-material')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_chrome?: unknown }).__basher_chrome),
  );
  await page.evaluate(() => {
    const w = window as unknown as {
      __basher_chrome: { getState: () => { setLeftSidebarCollapsed: (b: boolean) => void } };
    };
    w.__basher_chrome.getState().setLeftSidebarCollapsed(false);
  });
  // Collapse state is keyed by node TYPE in localStorage, not by node id, so re-selecting the
  // box shows the persisted choices for both 'Object' and 'BoxData'.
  await selectSeedBox(page);
  await expect(page.getByTestId('inspector-section-transform')).toHaveAttribute(
    'data-collapsed',
    'true',
  );
  await expect(page.getByTestId('inspector-section-material')).not.toHaveAttribute(
    'data-collapsed',
    'true',
  );
});

test('P6.W4#4 raw-fallback path: legacy nodes render flat (no sections)', async ({ page }) => {
  // Add a Character node — declared without inspectorSections (D-08 B).
  // Use the seed scene's existing Character node if present, else add one
  // via the agent surface; for v0.5 simplest, dispatch directly.
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_dag?: unknown }).__basher_dag),
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
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __basher_selection?: unknown }).__basher_selection),
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

test('P6.W4#5 sections appear in declared order (transform → mesh → material across the split pair)', async ({
  page,
}) => {
  await selectSeedBox(page);
  // The Object's own sections come first in ITS declared order, then the linked BoxData's in
  // ITS declared order — so the panel is two declared lists concatenated, not one re-sorted set.
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
    'inspector-section-transform',
    'inspector-section-mesh',
    'inspector-section-material',
  ]);
});

// #1703 — the bottom drawer's decided tab set: Shots · Dopesheet · NLA · Curves · Nodes · Library
// (Controllers stays after them until its fate is decided). Shots left the left panel for the
// drawer, the node view left the space switcher for the Nodes tab, and Library is an honest
// placeholder until the asset library moves in. Nodes opens taller than the others.
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

interface DagWindow {
  __basher_dag: { getState: () => { state: { nodes: Record<string, unknown> } } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('the drawer shows the decided tabs, in the decided order', async ({ page }) => {
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('timeline-tab-strip').getByRole('tab')).toHaveText([
    'Shots',
    'Dopesheet',
    'NLA',
    'Curves',
    'Nodes',
    'Library',
    'Controllers',
  ]);
});

test('Shots lives in the drawer, not the left panel', async ({ page }) => {
  await expect(page.getByTestId('left-sidebar-tab-shots')).toHaveCount(0);
  await openDrawerTab(page, 'shots');
  await expect(page.getByTestId('timeline-drawer').getByTestId('shots-panel')).toBeVisible();
});

test('Nodes is the node view: mounted only while its tab is up, and no longer a space', async ({
  page,
}) => {
  // Not a space: no button in the switcher or the toolbar.
  await expect(page.getByTestId('space-switch-graph')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-space-graph')).toHaveCount(0);
  await expect(page.getByTestId('graph-view')).toHaveCount(0);

  await openDrawerTab(page, 'nodes');
  await expect(page.getByTestId('timeline-drawer').getByTestId('graph-view')).toBeVisible();
  await expect(page.getByTestId('layout')).toHaveAttribute('data-space', 'view3d');

  // Another tab, or a closed drawer, unmounts it.
  await openDrawerTab(page, 'dopesheet');
  await expect(page.getByTestId('graph-view')).toHaveCount(0);
  await openDrawerTab(page, 'nodes');
  await expect(page.getByTestId('graph-view')).toHaveCount(1);
  await page.getByTestId('timeline-drawer-toggle').click();
  await expect(page.getByTestId('graph-view')).toHaveCount(0);

  // View ▸ Nodes opens the drawer on the Nodes tab.
  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-nodes').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('timeline-tab-nodes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('graph-view')).toBeVisible();
});

test('Nodes opens taller than the other tabs', async ({ page }) => {
  await openDrawerTab(page, 'dopesheet');
  const dope = (await page.getByTestId('timeline-drawer').boundingBox())!.height;
  await openDrawerTab(page, 'nodes');
  const nodes = (await page.getByTestId('timeline-drawer').boundingBox())!.height;
  expect(nodes).toBeGreaterThan(dope + 40);
});

test('Library is a placeholder that says what arrives there', async ({ page }) => {
  await openDrawerTab(page, 'library');
  const pane = page.getByTestId('library-pane');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText(/asset library/i);
});

// Keys pressed over a tab that is not a time editor keep the meaning they had in that tab's old
// home: the timeline's key region (#1483 — Delete deletes keys only) covers the time panes and the
// playback bar, not Shots. Before #1703 the shots list was in the left panel, where Delete after
// clicking a shot deleted the selected object; it must still do that from the drawer.
test('Delete after a real click on a shot row deletes the selected object, as it did in the left panel', async ({
  page,
}) => {
  await page.getByTestId('scene-tree-row-n_box').click();
  await openDrawerTab(page, 'shots');
  await page.getByTestId('shot-select-0').click();
  await page.keyboard.press('Delete');
  await expect
    .poll(() =>
      page.evaluate(
        () => 'n_box' in (window as unknown as DagWindow).__basher_dag.getState().state.nodes,
      ),
    )
    .toBe(false);
});

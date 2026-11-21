// #1707 — the asset library lives in the bottom drawer's Library tab; the left panel is the
// outliner only. Everything the old left Assets tab did works from the drawer: Import… opens the
// picker, a bundled tile dragged onto the viewport adds it to the scene, your imports rename and
// delete, and the toolbar's Assets button opens the drawer on Library. The tab adds what a list in
// a narrow panel could not: a source list, a kind filter, a search and a details panel.
import { expect, test } from './_fixtures';
import { openDrawerTab } from './_drawer';

// #1952 — works inside the outliner / inspector, so it runs with both panels open (see _fixtures).
test.use({ sidePanels: 'open' });

interface IngestFileShape {
  relativePath: string;
  bytes: Uint8Array;
}
interface BasherWindow {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
  __basher_ingestGltfFolder?: (
    files: ReadonlyArray<IngestFileShape>,
    folderName: string,
  ) => Promise<string>;
  __basher_ingestBvhFile?: (bytes: Uint8Array, name: string) => Promise<string>;
}

const CUBE = 'library-popover-item-assets/cube.gltf';
const WALK = 'library-popover-item-assets/motion/walk.bvh';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // A clean asset store, so "your imports" holds only what a test puts there.
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
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_ingestGltfFolder && w.__basher_ingestBvhFile);
  });
});

test('the left panel is the outliner only: no Assets tab, no tab strip', async ({ page }) => {
  await expect(page.getByTestId('left-sidebar')).toBeVisible();
  await expect(page.getByTestId('left-sidebar-tab-assets')).toHaveCount(0);
  await expect(page.getByTestId('left-sidebar-tabstrip')).toHaveCount(0);
  await expect(page.getByTestId('left-sidebar-assets-panel')).toHaveCount(0);
  await expect(page.getByTestId('scene-tree')).toBeVisible();
});

test('a remembered Assets tab falls back to the outliner', async ({ page }) => {
  await page.evaluate(() =>
    localStorage.setItem('basher.leftSidebar.v1', JSON.stringify({ activeTab: 'assets' })),
  );
  await page.reload();
  await expect(page.getByTestId('scene-tree')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('library-popover')).toHaveCount(0);
});

test('the toolbar Assets button opens the drawer on Library', async ({ page }) => {
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('timeline-tab-library')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('library-pane').getByTestId('library-popover')).toBeVisible();
  // A second press keeps it open on Library — the button reveals the library, it does not toggle.
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('timeline-drawer')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('top-toolbar-assets')).toHaveAttribute('data-active', 'true');
});

test('Import… in the Library tab opens the file picker', async ({ page }) => {
  await openDrawerTab(page, 'library');
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
  await page.getByTestId('library-import').click();
  await chooser;
});

test('Generate… lives in the Library tab', async ({ page }) => {
  await openDrawerTab(page, 'library');
  await expect(page.getByTestId('library-pane').getByTestId('generate-panel')).toBeVisible();
  // Selecting a tile shows its details; the Generate tile brings the form back.
  await expect(page.getByTestId(CUBE)).toHaveAttribute('data-available', 'true', {
    timeout: 10_000,
  });
  await page.getByTestId(CUBE).click();
  await expect(page.getByTestId('library-details-name')).toHaveText('Cube');
  await expect(page.getByTestId('library-details')).toContainText('gltf');
  await expect(page.getByTestId('generate-panel')).toBeHidden();
  await page.getByTestId('library-generate-tile').click();
  await expect(page.getByTestId('generate-panel')).toBeVisible();
});

test('a bundled tile dragged onto the viewport adds it to the scene', async ({ page }) => {
  await openDrawerTab(page, 'library');
  await expect(page.getByTestId(CUBE)).toHaveAttribute('data-available', 'true', {
    timeout: 10_000,
  });
  const before = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
  );
  // Native HTML5 drag is unreliable in Playwright with a custom MIME; dispatch the sequence with
  // one shared DataTransfer, as the tile's own dragstart would fill it.
  await page.evaluate((tileId) => {
    const tile = document.querySelector(`[data-testid="${tileId}"]`) as HTMLElement | null;
    const zone = document.querySelector('[data-testid="asset-drop-zone"]') as HTMLElement | null;
    if (!tile || !zone) throw new Error('tile or drop zone missing');
    const dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    tile.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  }, CUBE);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.values(
            (window as unknown as BasherWindow).__basher_dag.getState().state.nodes,
          ).some((n) => n.type === 'PolyMeshData'),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const after = await page.evaluate(
    () =>
      Object.keys((window as unknown as BasherWindow).__basher_dag.getState().state.nodes).length,
  );
  expect(after).toBeGreaterThan(before);
});

test('search, kind and source narrow the tiles', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const buf = await fetch('/fixtures/anim/walk.bvh').then((r) => r.arrayBuffer());
    await w.__basher_ingestBvhFile!(new Uint8Array(buf), 'my-walk');
  });
  await openDrawerTab(page, 'library');
  const mine = page.getByTestId('library-popover-my-import-user-imports/my-walk/my-walk.bvh');
  await expect(page.getByTestId(CUBE)).toBeVisible({ timeout: 10_000 });
  await expect(mine).toBeVisible({ timeout: 10_000 });

  // Search by name.
  await page.getByTestId('library-search').fill('walk');
  await expect(page.getByTestId(CUBE)).toHaveCount(0);
  await expect(page.getByTestId(WALK)).toBeVisible();
  await expect(mine).toBeVisible();
  await page.getByTestId('library-search').fill('');

  // Kind: motions only.
  await page.getByTestId('library-kind-motion').click();
  await expect(page.getByTestId(CUBE)).toHaveCount(0);
  await expect(page.getByTestId(WALK)).toBeVisible();
  await page.getByTestId('library-kind-all').click();
  await expect(page.getByTestId(CUBE)).toBeVisible();

  // Source: your imports only.
  await page.getByTestId('library-source-imports').click();
  await expect(page.getByTestId(CUBE)).toHaveCount(0);
  await expect(page.getByTestId(WALK)).toHaveCount(0);
  await expect(mine).toBeVisible();
  await expect(page.getByTestId('library-source-imports')).toContainText('1');
});

test('your imports rename and delete from the Library tab', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const buf = await fetch('/fixtures/anim/walk.bvh').then((r) => r.arrayBuffer());
    await w.__basher_ingestBvhFile!(new Uint8Array(buf), 'walk');
  });
  await openDrawerTab(page, 'library');
  await expect(
    page.getByTestId('library-popover-my-import-user-imports/walk/walk.bvh'),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('library-popover-menu-btn-walk').click();
  await page.getByTestId('library-popover-menu-rename-walk').click();
  const input = page.getByTestId('library-popover-rename-input-walk');
  await input.fill('stroll');
  await input.press('Enter');
  const renamed = page.getByTestId('library-popover-my-import-user-imports/stroll/walk.bvh');
  await expect(renamed).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('library-popover-menu-btn-stroll').click();
  await page.getByTestId('library-popover-menu-delete-stroll').click();
  await expect(renamed).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('library-popover-delete-banner')).toHaveCount(0);
});

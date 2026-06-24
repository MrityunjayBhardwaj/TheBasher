// Compositor spine 1b — File ▸ Import Media… ingests an image into a MediaClip
// node. Falsifiable against the REAL browser path: the file chooser → a real PNG
// → createImageBitmap probes its true dimensions → OPFS write → a MediaClip node
// lands in the DAG with mediaKind 'image' and width/height > 0. Unwiring the menu
// item, the picker, or the ingest op drops the count back → this fails.

import { expect, test } from './_fixtures';

interface DagWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params?: Record<string, unknown> }> };
    };
  };
}

async function mediaClips(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag?.getState().state.nodes ?? {};
    return Object.values(nodes)
      .filter((n) => n.type === 'MediaClip')
      .map((n) => n.params ?? {});
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
});

test('File ▸ Import Media… ingests a PNG into a MediaClip with real probed dimensions', async ({
  page,
}) => {
  expect(await mediaClips(page)).toHaveLength(0);

  await page.getByTestId('menu-file-button').click();
  await expect(page.getByTestId('menu-file-import-media')).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('menu-file-import-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');

  await expect.poll(() => mediaClips(page).then((c) => c.length), { timeout: 8_000 }).toBe(1);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  const [clip] = await mediaClips(page);
  expect(clip.mediaKind).toBe('image');
  expect(clip.srcFrames).toBe(1);
  expect(Number(clip.width)).toBeGreaterThan(0);
  expect(Number(clip.height)).toBeGreaterThan(0);
  expect(String(clip.src)).toContain('user-imports/');
});

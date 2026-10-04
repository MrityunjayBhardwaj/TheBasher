// #1454 — an OS file drop whose items give no file-system entry still imports, from
// `dataTransfer.files`. A script-built `DataTransfer` is such a drop in Chromium:
// `webkitGetAsEntry()` returns null for its items, though `files` holds the file. The
// spec first proves that premise, so a green here means the FileList door answered.
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: { getState: () => { state: { nodes: Record<string, { type: string }> } } };
}

test('#1454 — a dropped .glb with no file entry imports through the FileList', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });

  const nodeCount = () =>
    page.evaluate(
      () => Object.keys((window as unknown as W).__basher_dag.getState().state.nodes).length,
    );
  const before = await nodeCount();

  const probe = await page.evaluate(async () => {
    const bytes = await (await fetch('/assets/tangent-mirror.glb')).arrayBuffer();
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'tangent-mirror.glb', { type: 'model/gltf-binary' }));
    const zone = document.querySelector('[data-testid="asset-drop-zone"]') as HTMLElement;
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    return {
      entryNull: dt.items[0].webkitGetAsEntry() === null,
      files: dt.files.length,
      types: Array.from(dt.types),
    };
  });
  // The premise: the items door gives nothing, the FileList holds the file.
  expect(probe).toEqual({ entryNull: true, files: 1, types: ['Files'] });

  await expect
    .poll(nodeCount, { timeout: 20_000, message: 'the drop imported' })
    .toBeGreaterThan(before);
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
});

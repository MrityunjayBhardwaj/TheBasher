// Compositor spine 1c.2 — the layer Add path. Falsifiable against the REAL app:
// in Video mode, Add Layer ▸ Media File… ingests a PNG and wraps it as a Layer in
// the active comp, in ONE undo. Verified end-to-end: the layer count flips to 1,
// the Composition's `layers` list gains one Layer, and that Layer's `source` edge
// points at a MediaClip. Unwiring buildAddLayerOps / the picker drops these.

import { expect, test } from './_fixtures';

interface DagNode {
  id: string;
  type: string;
  inputs?: Record<string, { node: string; socket: string } | { node: string; socket: string }[]>;
}
interface DagWindow {
  __basher_dag?: { getState: () => { state: { nodes: Record<string, DagNode> } } };
}

function dagNodes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as DagWindow;
    return Object.values(w.__basher_dag?.getState().state.nodes ?? {});
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('menu-file-button')).toBeVisible();
  await page.getByTestId('space-switch-video').click();
  await page.getByTestId('video-mode-new-comp').click();
  await expect(page.getByTestId('video-mode-comp-name')).toHaveText('Composition 1');
});

test('Add Layer ▸ Media File wraps a clip as a Layer in the active comp', async ({ page }) => {
  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('0 layers');

  await page.getByTestId('video-mode-add-layer').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('video-mode-add-media').click(),
  ]);
  await chooser.setFiles('public/fixtures/multifile/flat/texture.png');

  await expect(page.getByTestId('video-mode-layer-count')).toHaveText('1 layer', {
    timeout: 8_000,
  });
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  // DAG wiring: Composition.layers → Layer.source → MediaClip.
  const nodes = await dagNodes(page);
  const comp = nodes.find((n) => n.type === 'Composition');
  const layer = nodes.find((n) => n.type === 'Layer');
  const media = nodes.find((n) => n.type === 'MediaClip');
  expect(comp && layer && media).toBeTruthy();

  const layersBinding = comp!.inputs?.layers;
  const layerRefs = Array.isArray(layersBinding)
    ? layersBinding
    : layersBinding
      ? [layersBinding]
      : [];
  expect(layerRefs.map((r) => r.node)).toContain(layer!.id);

  const sourceBinding = layer!.inputs?.source;
  const sourceRef = Array.isArray(sourceBinding) ? sourceBinding[0] : sourceBinding;
  expect(sourceRef?.node).toBe(media!.id);
});

test('3D Scene Render entry is present but disabled (render→OPFS not yet wired)', async ({
  page,
}) => {
  await page.getByTestId('video-mode-add-layer').click();
  await expect(page.getByTestId('video-mode-add-scene-render')).toBeDisabled();
});

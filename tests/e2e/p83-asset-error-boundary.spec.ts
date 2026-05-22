// Asset load-error surfacing (#83 gap 2 runtime proof).
//
// Before this: a GltfAsset pointing at a missing / unreadable OPFS path
// threw inside the R3F tree, the Canvas-root <Suspense fallback={null}>
// swallowed it, and the user saw a blank slot with no reason. The
// AssetErrorBoundary now catches the throw per-asset, reports it to the
// assetErrorStore, and the AssetErrorBanner surfaces "asset failed:
// <ref> — <reason>" — while the rest of the scene keeps rendering.
//
// This test drops a GltfAsset whose assetRef has no backing OPFS file
// (opfsLoader's storage.read rejects → suspense promise rejects → React
// re-throws at the boundary) and asserts the banner appears naming the
// bad ref. Observation over inference: we read the actual rendered DOM
// banner, not the store.
//
// REF: #83 gap 2, src/viewport/AssetErrorBoundary.tsx,
// src/app/AssetErrorBanner.tsx, src/app/stores/assetErrorStore.ts.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } } };
      dispatch: (op: unknown) => void;
      dispatchAtomic?: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_evaluate: unknown;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    if (typeof navigator?.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry('basher', { recursive: true });
      } catch {
        /* OPFS entry absent on first run */
      }
    }
  });
  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_evaluate);
  });
});

test('P83#2 — a missing-asset GltfAsset surfaces a load-error banner (not a blank viewport)', async ({
  page,
}) => {
  // The banner must be hidden before any failure.
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);

  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const sceneRef = dag.state.outputs.scene;
    if (!sceneRef) throw new Error('no scene output');

    const ops = [
      {
        type: 'addNode',
        nodeId: 'p83_bad',
        nodeType: 'GltfAsset',
        // No such file in OPFS — opfsLoader.read rejects, the suspense
        // promise rejects, React re-throws at AssetErrorBoundary.
        params: { assetRef: 'assets/does-not-exist-p83.glb' },
      },
      {
        type: 'connect',
        from: { node: 'p83_bad', socket: 'out' },
        to: { node: sceneRef.node, socket: 'children' },
      },
    ];
    if (dag.dispatchAtomic) dag.dispatchAtomic(ops, 'user', 'p83 bad asset');
    else ops.forEach((op) => dag.dispatch(op));
  });

  // The boundary catches the rejected load and the banner surfaces it.
  const banner = page.getByTestId('asset-error-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('asset failed:');
  await expect(banner).toContainText('assets/does-not-exist-p83.glb');

  // Dismiss clears the row → banner disappears (no other failures).
  await page.getByRole('button', { name: /Dismiss error for assets\/does-not-exist-p83/ }).click();
  await expect(page.getByTestId('asset-error-banner')).toHaveCount(0);
});

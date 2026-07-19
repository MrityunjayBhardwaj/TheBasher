// H48 4th-occurrence GATE (B13) — editing an UNRELATED node must NOT re-render a
// mounted glTF asset's React subtree, while editing the asset's OWN node still must.
//
// The user's symptom: in a heavy imported scene, manipulating ANY node dropped the
// viewport to ~16fps because GltfAssetR (which re-applies TRS/material across every
// mesh) re-rendered on every dispatch. Root cause: GltfAssetR subscribed to the
// WHOLE node table (`useDagStore(s => s.state.nodes)`), whose ref flips on every
// edit (ops.ts structural sharing). The fix narrows that subscription to only THIS
// asset's dependency nodes, compared with zustand `shallow` (src/app/gltfAssetDeps.ts)
// — an unrelated edit yields a shallow-equal array → no re-render; a relevant edit
// flips one element's ref → re-render (the H40 override-freeze guard is preserved).
//
// This gate proves BOTH halves on the REAL render path with a DEV render-count seam
// (src/perf/renderCounter.ts). Render count is asset-size and GPU independent (it
// counts React renders, not frames), so the gate runs headless on a tiny committed
// fixture — the cicada's size only changes the COST per re-render, not WHETHER it
// re-renders. Falsified: a broad `Object.values(s.state.nodes)` selector turns the
// unrelated-edit assertion from +0 to +10 (observed 2026-06-11).
//
// REF: src/viewport/SceneFromDAG.tsx GltfAssetR, src/app/gltfAssetDeps.ts,
//      src/perf/renderCounter.ts, [[H48]] [[B13]] [[H40]]. Branch ux-overhall.

import { expect, test } from './_fixtures';
import { splitCubeOps } from './_splitCube';

// Plain glTF (NOT cube-draco — the Draco decoder fails under the test route, so the
// asset would throw past the AssetErrorBoundary and never mount/subscribe).
const ASSET_REF = 'assets/cube.gltf';

interface DagOp {
  type: string;
  [k: string]: unknown;
}
interface RcWindow {
  __basher_dag: {
    getState: () => {
      state: { outputs: Record<string, { node: string } | undefined> };
      dispatch: (op: DagOp) => void;
      dispatchAtomic?: (ops: DagOp[], source?: string, label?: string) => void;
    };
  };
  __basher_render_counts?: () => Record<string, number>;
}

async function settle(page: import('@playwright/test').Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}
function gltfRenderCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as RcWindow).__basher_render_counts?.().GltfAssetR ?? 0,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => Boolean((window as unknown as RcWindow).__basher_dag));
});

test('H48/B13 — unrelated edit re-renders a glTF asset 0× (own-node edit still does)', async ({
  page,
}) => {
  // Mount a glTF asset + an UNRELATED sibling box under the scene.
  await page.evaluate(
    ({ ref, cubeOps }) => {
      const dag = (window as unknown as RcWindow).__basher_dag.getState();
      const sceneRef = dag.state.outputs.scene ?? dag.state.outputs.render;
      if (!sceneRef) throw new Error('no scene output');
      const ops: DagOp[] = [
        { type: 'addNode', nodeId: 'rc_gltf', nodeType: 'GltfAsset', params: { assetRef: ref } },
        {
          type: 'connect',
          from: { node: 'rc_gltf', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
        ...(cubeOps as DagOp[]),
        {
          type: 'connect',
          from: { node: 'rc_box', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ];
      if (dag.dispatchAtomic) dag.dispatchAtomic(ops, 'user', 'rc setup');
      else ops.forEach((op) => dag.dispatch(op));
    },
    { ref: ASSET_REF, cubeOps: splitCubeOps({ objectId: 'rc_box' }) },
  );

  // Wait for GltfAssetR to mount, then let its render count STABILISE (a late
  // suspense-resolve bump must not pollute the measurement).
  await page.waitForFunction(
    () => ((window as unknown as RcWindow).__basher_render_counts?.().GltfAssetR ?? 0) > 0,
    { timeout: 15_000 },
  );
  let prev = -1;
  for (let i = 0; i < 12; i++) {
    await settle(page);
    const c = await gltfRenderCount(page);
    if (c === prev) break;
    prev = c;
  }
  const before = await gltfRenderCount(page);

  // Phase 1 — 10 edits to the UNRELATED sibling box.
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(
      (x) =>
        (window as unknown as RcWindow).__basher_dag.getState().dispatch({
          type: 'setParam',
          nodeId: 'rc_box',
          paramPath: 'position',
          value: [x, 0, 0],
        }),
      i,
    );
  }
  await settle(page);
  await settle(page);
  const afterUnrelated = await gltfRenderCount(page);

  // Phase 2 — 1 edit to the asset's OWN node (its `value` ref must flip → re-render,
  // so a real per-child override would re-apply; this is the H40 freeze guard).
  await page.evaluate(() =>
    (window as unknown as RcWindow).__basher_dag.getState().dispatch({
      type: 'setParam',
      nodeId: 'rc_gltf',
      paramPath: 'suppressedChildren',
      value: ['x'],
    }),
  );
  await settle(page);
  await settle(page);
  const afterOwn = await gltfRenderCount(page);

  // The fix, in two assertions:
  expect(afterUnrelated - before).toBe(0); // unrelated edits → ZERO re-renders
  expect(afterOwn).toBeGreaterThan(afterUnrelated); // own-node edit STILL re-renders
});

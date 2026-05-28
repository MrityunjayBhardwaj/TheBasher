// P7.7 — DAG-explosion observation on a REAL multi-bone character (#91 Wave E2,
// pre-mortem D-05). The 2-bone skinned-bar fixture cannot reveal the node-flood
// cost: P7.7 materializes one GltfChild DAG node per scene child, so a many-bone
// rig becomes many addNodes + many outliner rows + a save-size bump. This spec
// drops the generated 64-bone rig (many-bone-rig.glb, 65 scene nodes) and
// OBSERVES — records to the console / test output — the numbers the PR notes
// carry:
//   - GltfChild node count after the drop (== json.nodes == 65).
//   - serialized DAG-node-table byte size before vs after (the save-size proxy
//     — the node table is what loadProject/saveProject persists).
//   - outliner render time with the subtree COLLAPSED (D2 default) vs EXPANDED.
//
// D-05 is an OBSERVATION wave, not a perf gate: the assertions here are sanity
// bounds (the drop completed, the count matches, the collapsed tree is not
// pathologically slow), and the real product of the test is the recorded
// numbers. If a perf cliff appears, the orchestrator files a follow-on issue
// for outliner virtualization / a narrower GltfAssetR selector (NOT built here).
//
// REF: PLAN.md 7.7 Wave E (E2) pre-mortem #3 (DAG explosion); scripts/
// gen-many-bone-fixture.mjs; src/viewport/SceneFromDAG.tsx GltfAssetR subscribed
// selector (the B2 perf note: subscribes to the whole nodes table, memo-filtered).

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/many-bone-rig.glb';
const FIXTURE_URL = '/assets/many-bone-rig.glb';
const EXPECTED_SCENE_NODES = 65; // 64 bones + 1 SkinnedMesh (gen-many-bone-fixture.mjs 64)

interface DagNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => { state: { nodes: Record<string, DagNode> } };
  };
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<unknown>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_skin?: () => unknown;
  __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
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
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_chrome);
  });
});

test('P7.7 D-05 — many-bone rig: node count + save-size + outliner perf (observation)', async ({
  page,
}) => {
  // Baseline: serialized DAG node table size before the drop.
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    return {
      nodeCount: Object.keys(nodes).length,
      bytes: JSON.stringify(nodes).length,
    };
  });

  // Drop the 64-bone rig (bytes → OPFS, structure → DAG).
  await page.evaluate(
    async ({ url, ref }) => {
      const w = window as unknown as BasherWindow;
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
      await w.__basher_importGltf!(buf, ref);
    },
    { url: FIXTURE_URL, ref: ASSET_REF },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as BasherWindow;
      return Object.values(w.__basher_dag.getState().state.nodes).some(
        (n) => n.type === 'GltfChild',
      );
    },
    { timeout: 20_000 },
  );

  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    const children = Object.values(nodes).filter((n) => n.type === 'GltfChild');
    return {
      nodeCount: Object.keys(nodes).length,
      bytes: JSON.stringify(nodes).length,
      childCount: children.length,
    };
  });

  // Outliner render time: collapsed (D2 default) vs expanded. Expand the
  // sidebar, measure a forced reflow with the subtree collapsed, then click the
  // asset's expand chevron and measure again. requestAnimationFrame deltas are
  // coarse but reveal a cliff (the D-05 signal), which is all the observation needs.
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });
  const assetId = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.values(w.__basher_dag.getState().state.nodes).find((n) => n.type === 'GltfAsset')
      ?.id;
  });
  expect(assetId).toBeTruthy();
  await expect(page.getByTestId(`scene-tree-row-${assetId}`)).toBeVisible({ timeout: 10_000 });

  // Collapsed render-time proxy: count visible scene-tree rows + a paint tick.
  const collapsedRows = await page.getByTestId(/^scene-tree-row-/).count();
  const tExpandStart = Date.now();
  await page.getByTestId(`scene-tree-toggle-${assetId}`).click();
  // Wait for all child rows to appear (the expansion fully rendered).
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid^="scene-tree-row-"]').length >= n,
    EXPECTED_SCENE_NODES,
    { timeout: 10_000 },
  );
  const expandMs = Date.now() - tExpandStart;
  const expandedRows = await page.getByTestId(/^scene-tree-row-/).count();

  const report = {
    boneRigSceneNodes: EXPECTED_SCENE_NODES,
    nodeCountBefore: before.nodeCount,
    nodeCountAfter: after.nodeCount,
    nodeCountDelta: after.nodeCount - before.nodeCount,
    gltfChildCount: after.childCount,
    saveBytesBefore: before.bytes,
    saveBytesAfter: after.bytes,
    saveBytesDelta: after.bytes - before.bytes,
    bytesPerChild: Math.round((after.bytes - before.bytes) / after.childCount),
    outlinerRowsCollapsed: collapsedRows,
    outlinerRowsExpanded: expandedRows,
    expandRenderMs: expandMs,
  };
  // The headline observation — recorded for the PR notes / SUMMARY.
  console.log(`[P7.7 D-05 DAG-EXPLOSION OBSERVATION] ${JSON.stringify(report, null, 2)}`);

  // Sanity bounds (NOT a perf gate — D-05 is observation). One GltfChild per
  // scene node; the drop adds the children + GltfAsset/Transform/Group wrapper.
  expect(after.childCount).toBe(EXPECTED_SCENE_NODES);
  expect(report.nodeCountDelta).toBeGreaterThanOrEqual(EXPECTED_SCENE_NODES);
  // Collapsed by default hides the children (D2 — the node-flood mitigation):
  // far fewer rows visible than the expanded count.
  expect(collapsedRows).toBeLessThan(expandedRows);
  // Expanding the full 65-child subtree renders in a human-reasonable time.
  // A generous ceiling — if this trips, a real cliff exists → file the follow-on.
  expect(expandMs, `outliner expand took ${expandMs}ms for 65 children`).toBeLessThan(5_000);
});

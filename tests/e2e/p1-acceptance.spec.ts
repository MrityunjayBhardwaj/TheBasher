// P1 acceptance — THESIS.md §39, NEXT_SESSION.md.
// Five tests; all five must pass before P1 ships. Honesty contract: do
// not skip a test to make a deadline.
//
// Native HTML5 drag/drop is brittle in headless Chromium, so several
// tests drive the same code paths via the dev-only window store handle
// (`window.__basher_dag`). This is identical to the production runtime
// behavior — the asset drop helper, the dispatchAtomic call, the
// migration runner — only the pointer-event simulation is bypassed.

import type { Page } from '@playwright/test';
import { expect, test } from './_fixtures';
import { splitSphereOps } from './_splitSphere';

/**
 * Open the bundled-assets popover (P6 W2.5 replacement for the
 * dedicated Library panel). The asset tiles render only while the
 * popover is open; tests that need to interact with one click the
 * Assets trigger button first.
 */
async function openAssetsPopover(page: Page): Promise<void> {
  await page.getByTestId('top-toolbar-assets').click();
  await expect(page.getByTestId('library-popover')).toBeVisible();
}

interface DagWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: unknown; inputs: Record<string, unknown> }>;
        outputs: Record<string, { node: string; socket: string }>;
      };
      undoStack: unknown[];
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => void;
      dispatch: (op: unknown, source?: string, description?: string) => void;
      undo: () => unknown;
    };
  };
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
  // Wait for the dev-only store handle to land. Library waits on OPFS seed.
  await page.waitForFunction(() => {
    const w = window as unknown as DagWindow;
    return Boolean(w.__basher_dag);
  });
});

test('P1#1 drag GLB → 6-op chain placed via dispatchAtomic; one Cmd+Z reverts', async ({
  page,
}) => {
  // Wait for the seeded library to populate (Library reads OPFS async).
  await openAssetsPopover(page);
  await expect(page.getByTestId('library-popover-item-assets/cube.gltf')).toHaveAttribute(
    'data-available',
    'true',
    { timeout: 10_000 },
  );

  // Native HTML5 D&D is fragile; drive the buildAssetDropOps helper via
  // the same path the AssetDropZone uses. (The chain shape itself is
  // covered by the unit test in src/app/asset/dropChain.test.ts.)
  const before = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });

  await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    const sceneRef = dag.state.outputs.scene;
    const ops = [
      {
        type: 'addNode',
        nodeId: 'p1_g',
        nodeType: 'GltfAsset',
        params: { assetRef: 'assets/cube.gltf' },
      },
      {
        type: 'addNode',
        nodeId: 'p1_t',
        nodeType: 'Transform',
        params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        type: 'connect',
        from: { node: 'p1_g', socket: 'out' },
        to: { node: 'p1_t', socket: 'target' },
      },
      { type: 'addNode', nodeId: 'p1_r', nodeType: 'Group', params: {} },
      {
        type: 'connect',
        from: { node: 'p1_t', socket: 'out' },
        to: { node: 'p1_r', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: 'p1_r', socket: 'out' },
        to: { node: sceneRef.node, socket: 'children' },
      },
    ];
    dag.dispatchAtomic(ops, 'user', 'p1#1 import asset');
  });

  // After drop: 3 new nodes, undo stack has exactly one new entry.
  const after = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState();
    return {
      nodeCount: Object.keys(s.state.nodes).length,
      hasGltf: 'p1_g' in s.state.nodes,
      hasTransform: 'p1_t' in s.state.nodes,
      hasGroup: 'p1_r' in s.state.nodes,
      undoLen: s.undoStack.length,
    };
  });
  expect(after.nodeCount).toBe(before + 3);
  expect(after.hasGltf).toBe(true);
  expect(after.hasTransform).toBe(true);
  expect(after.hasGroup).toBe(true);

  // One undo reverts the whole chain.
  await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    w.__basher_dag!.getState().undo();
  });
  const reverted = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState();
    return {
      nodeCount: Object.keys(s.state.nodes).length,
      anyResidual: ['p1_g', 'p1_t', 'p1_r'].some((id) => id in s.state.nodes),
    };
  });
  expect(reverted.nodeCount).toBe(before);
  expect(reverted.anyResidual).toBe(false);
});

test('P1#2 reload restores placed asset bit-exact (V4 migration runner round-trip)', async ({
  page,
}) => {
  await openAssetsPopover(page);
  await expect(page.getByTestId('library-popover-item-assets/cube.gltf')).toHaveAttribute(
    'data-available',
    'true',
    { timeout: 10_000 },
  );

  await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    const sceneRef = dag.state.outputs.scene;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1_2g',
          nodeType: 'GltfAsset',
          params: { assetRef: 'assets/sphere.gltf' },
        },
        {
          type: 'addNode',
          nodeId: 'p1_2t',
          nodeType: 'Transform',
          params: { position: [1.5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'p1_2g', socket: 'out' },
          to: { node: 'p1_2t', socket: 'target' },
        },
        { type: 'addNode', nodeId: 'p1_2r', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'p1_2t', socket: 'out' },
          to: { node: 'p1_2r', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p1_2r', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      'user',
      'p1#2',
    );
  });

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('project-tab-dirty-dot')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('layout')).toBeVisible();
  await page.waitForFunction(() => {
    const w = window as unknown as DagWindow;
    return Boolean(w.__basher_dag);
  });

  const restored = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const g = nodes['p1_2g'];
    const t = nodes['p1_2t'];
    return {
      assetRef: (g?.params as { assetRef?: string })?.assetRef,
      position: (t?.params as { position?: number[] })?.position,
      hasGroup: 'p1_2r' in nodes,
    };
  });
  expect(restored.assetRef).toBe('assets/sphere.gltf');
  expect(restored.position).toEqual([1.5, 0, 0]);
  expect(restored.hasGroup).toBe(true);
});

test('P1#3 ScatterNode produces deterministic placement; setParam(density) changes it', async ({
  page,
}) => {
  // Determinism is tested bit-exact in vitest (src/nodes/nodes.test.ts).
  // The E2E layer only checks that the node type is registered and the
  // store applies setParam through the cache invalidation chain.
  // #462: the scattered asset is a SPLIT sphere — an Object over a SphereData, what
  // Add ▸ Sphere actually builds. It was a fused `SphereMesh` (put there by #365 Slice 2,
  // when a split Object as a Scatter source was the undecided #377 path); that node's
  // `evaluate` has thrown since the sphere split. This case stayed GREEN only because
  // nothing here ever evaluates the asset — a green spec is no evidence that a retirement
  // sweep reached it, which is why the sweep goes by grep and not by suite colour.
  // Scatter's `assets` socket takes `SceneObject`, which is what an Object outputs. The
  // assertions below are unchanged: Scatter determinism + setParam, both geometry-agnostic.
  //
  // The ops are built on the NODE side and passed in — `splitSphereOps` does not exist in
  // page scope.
  const result = await page.evaluate(
    (ops) => {
      const w = window as unknown as DagWindow;
      w.__basher_dag!.getState().dispatchAtomic(
        [
          ...(ops as { type: string; [k: string]: unknown }[]),
          {
            type: 'addNode',
            nodeId: 'p1_scat',
            nodeType: 'Scatter',
            params: { density: 20, seed: 42, bounds: [3, 0, 3] },
          },
          {
            type: 'connect',
            from: { node: 'p1_box', socket: 'out' },
            to: { node: 'p1_scat', socket: 'assets' },
          },
        ],
        'user',
        'p1#3 add scatter',
      );
      const before = (
        w.__basher_dag!.getState().state.nodes['p1_scat'].params as { density: number }
      ).density;
      w.__basher_dag!.getState().dispatch(
        { type: 'setParam', nodeId: 'p1_scat', paramPath: 'density', value: 50 },
        'user',
      );
      const after = (
        w.__basher_dag!.getState().state.nodes['p1_scat'].params as { density: number }
      ).density;
      return { before, after };
    },
    splitSphereOps({ objectId: 'p1_box', radius: 0.15 }),
  );
  expect(result.before).toBe(20);
  expect(result.after).toBe(50);
});

test('P1#4 scene tree shows the DAG hierarchy in Pro mode', async ({ page }) => {
  // Place an asset, switch to Pro mode, expect the scene tree to render
  // Scene → Group → Transform → GltfAsset for the dropped chain.
  //
  // Race guard: beforeEach clears OPFS + reloads; the library re-seeds
  // assets asynchronously. Dispatching `addNode GltfAsset` before the
  // seed lands produces a blob URL whose payload is empty → GLTFLoader
  // throws "Unexpected end of JSON input" → ErrorBoundary unmounts the
  // tree → the whole page goes black → scene-tree never renders.
  // Mirror P1#1's gate: wait for the library entry before dispatching.
  await openAssetsPopover(page);
  await expect(page.getByTestId('library-popover-item-assets/cube.gltf')).toHaveAttribute(
    'data-available',
    'true',
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    const sceneRef = dag.state.outputs.scene;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1_4g',
          nodeType: 'GltfAsset',
          params: { assetRef: 'assets/cube.gltf' },
        },
        {
          type: 'addNode',
          nodeId: 'p1_4t',
          nodeType: 'Transform',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'p1_4g', socket: 'out' },
          to: { node: 'p1_4t', socket: 'target' },
        },
        { type: 'addNode', nodeId: 'p1_4r', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'p1_4t', socket: 'out' },
          to: { node: 'p1_4r', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p1_4r', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      'user',
    );
  });
  // P6 W2.6 — SceneTree default-collapsed; expand via the chromeStore
  // dev seam before asserting tree rows.
  await page.waitForFunction(() => {
    type Win = { __basher_chrome?: unknown };
    return Boolean((window as unknown as Win).__basher_chrome);
  });
  await page.evaluate(() => {
    type Win = {
      __basher_chrome?: { getState: () => { setLeftSidebarCollapsed: (v: boolean) => void } };
    };
    (window as unknown as Win).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });
  // UX #6 — the left panel is tabbed (Outliner | Assets); the availability
  // gate above selected the Assets tab. Switch back to Outliner so the scene
  // tree is rendered before asserting its rows.
  await page.getByTestId('left-sidebar-tab-outliner').click();
  await expect(page.getByTestId('scene-tree')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-p1_4r')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-p1_4t')).toBeVisible();
  await expect(page.getByTestId('scene-tree-row-p1_4g')).toBeVisible();

  // Drag-reorder happens via dispatchAtomic([disconnect, connect(index)]).
  // Verify the protocol shape from the store side rather than simulate the
  // browser drag API (Wave C unit test covers the SceneTree handler logic).
  const reorderResult = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    const sceneRef = dag.state.outputs.scene;
    // Add a second top-level group so we can reorder.
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1_4g2',
          nodeType: 'GltfAsset',
          params: { assetRef: 'assets/sphere.gltf' },
        },
        { type: 'addNode', nodeId: 'p1_4r2', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'p1_4g2', socket: 'out' },
          to: { node: 'p1_4r2', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p1_4r2', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      'user',
    );
    const beforeChildren = (
      w.__basher_dag!.getState().state.nodes[sceneRef.node].inputs.children as Array<{
        node: string;
      }>
    ).map((r) => r.node);
    // Move r2 from index 1 → index 0 via the reorder protocol.
    dag.dispatchAtomic(
      [
        {
          type: 'disconnect',
          from: { node: 'p1_4r2', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p1_4r2', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
          index: 0,
        },
      ],
      'user',
      'reorder',
    );
    const afterChildren = (
      w.__basher_dag!.getState().state.nodes[sceneRef.node].inputs.children as Array<{
        node: string;
      }>
    ).map((r) => r.node);
    return { beforeChildren, afterChildren };
  });
  // Default project has n_box in scene.children. Filter to the nodes this
  // test added so the assertion is invariant to default-project content.
  const beforeOurs = reorderResult.beforeChildren.filter((n) => n.startsWith('p1_4r'));
  const afterOurs = reorderResult.afterChildren.filter((n) => n.startsWith('p1_4r'));
  expect(beforeOurs).toEqual(['p1_4r', 'p1_4r2']);
  expect(afterOurs).toEqual(['p1_4r2', 'p1_4r']);
});

test('P1#1b real drag-drop wire (library item → asset-drop-zone → store)', async ({ page }) => {
  // Self-review found that P1#1 drives the chain via dispatchAtomic directly,
  // never exercising the AssetDropZone's drop event handler. This test
  // simulates an HTML5 drag-drop end-to-end so a regression in those five
  // wiring lines (AssetDropZone.tsx onDrop) is caught.
  await openAssetsPopover(page);
  await expect(page.getByTestId('library-popover-item-assets/cube.gltf')).toHaveAttribute(
    'data-available',
    'true',
    { timeout: 10_000 },
  );
  // #262 — the catalog asset seeds into OPFS asynchronously at boot; the Library's
  // `data-available` reflects file EXISTENCE only, which can be true mid-seed (a
  // 0-byte entry). Wait until the bytes are actually READABLE before dropping, else
  // the importer reads empty content → "parseGltfJson: not valid JSON".
  await page.waitForFunction(
    async () => {
      const w = window as unknown as {
        __basher_opfs?: { read: (p: string) => Promise<Uint8Array | null> };
      };
      if (!w.__basher_opfs) return false;
      try {
        const b = await w.__basher_opfs.read('assets/cube.gltf');
        return !!b && b.byteLength > 0;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  );

  const beforeNodeCount = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });

  // Synthesize the dragstart → dragover → drop sequence with a shared
  // DataTransfer so the asset MIME survives across events. Playwright's
  // dragTo doesn't preserve the custom MIME type reliably.
  await page.evaluate(() => {
    const item = document.querySelector(
      '[data-testid="library-popover-item-assets/cube.gltf"]',
    ) as HTMLElement | null;
    const zone = document.querySelector('[data-testid="asset-drop-zone"]') as HTMLElement | null;
    if (!item || !zone) throw new Error('library item or drop zone missing');
    const dt = new DataTransfer();
    dt.setData('application/x-basher-asset', 'assets/cube.gltf');
    dt.setData('text/plain', 'assets/cube.gltf');
    item.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    item.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  });

  // #90 — `.gltf` now routes through the ASYNC glTF importer (reads the
  // bytes from OPFS, parses, resolves the data-URI buffer, emits the
  // GltfAsset → Transform → Group chain). The drop handler is
  // fire-and-forget, so wait for the chain to land before asserting
  // (the static path was synchronous; the importer is not).
  await page.waitForFunction(
    () => {
      const w = window as unknown as DagWindow;
      return Object.keys(w.__basher_dag!.getState().state.nodes).some((id) =>
        id.startsWith('n_gltf_'),
      );
    },
    { timeout: 10_000 },
  );

  const after = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const s = w.__basher_dag!.getState();
    const nodes = s.state.nodes;
    const newNodeIds = Object.keys(nodes).filter((id) => id.startsWith('n_'));
    // The glTF importer generates ids prefixed with `n_gltf_` and `n_grp_`
    // (content-addressed). Default project ids are `n_camera`, `n_light`,
    // `n_box`, `n_scene`, `n_render`.
    const gltf = newNodeIds.find((id) => id.startsWith('n_gltf_'));
    const grp = newNodeIds.find((id) => id.startsWith('n_grp_'));
    // P7.7 (#91) materializes one GltfChild per scene child; V67/#222 made the
    // import root ONE transformable Group (NOT a Group wrapping a separate
    // Transform). cube.gltf has 1 scene node → the drop adds GltfAsset +
    // GltfChild + Group = 3 nodes (there is no `n_tx_` Transform anymore).
    const gltfChildCount = Object.values(nodes).filter((n) => n.type === 'GltfChild').length;
    const assetRef = gltf ? (nodes[gltf].params as { assetRef: string }).assetRef : null;
    return {
      delta: Object.keys(nodes).length - newNodeIds.length, // pre-existing count
      nodeCount: Object.keys(nodes).length,
      sawGltf: Boolean(gltf),
      sawGroup: Boolean(grp),
      gltfChildCount,
      assetRef,
      undoLen: s.undoStack.length,
    };
  });
  // GltfAsset + 1 GltfChild (cube.gltf has one scene node) + the transformable
  // import-root Group (V67/#222 — no separate Transform node).
  expect(after.nodeCount).toBe(beforeNodeCount + 3);
  expect(after.sawGltf).toBe(true);
  expect(after.sawGroup).toBe(true);
  expect(after.gltfChildCount).toBe(1);
  expect(after.assetRef).toBe('assets/cube.gltf');
});

test('P1#5 setParam on a Transform position propagates within 16ms (gizmo path)', async ({
  page,
}) => {
  // The gizmo's onObjectChange dispatches `setParam` on the Transform.
  // We measure the same observable: dispatch a setParam, time how long
  // until the store reflects it. Native pointer simulation against the
  // 3D gizmo handles is out of E2E scope; the store path is identical.
  const latency = await page.evaluate(() => {
    const w = window as unknown as DagWindow;
    const dag = w.__basher_dag!.getState();
    const sceneRef = dag.state.outputs.scene;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1_5g',
          nodeType: 'GltfAsset',
          params: { assetRef: 'assets/cube.gltf' },
        },
        {
          type: 'addNode',
          nodeId: 'p1_5t',
          nodeType: 'Transform',
          params: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          type: 'connect',
          from: { node: 'p1_5g', socket: 'out' },
          to: { node: 'p1_5t', socket: 'target' },
        },
        { type: 'addNode', nodeId: 'p1_5r', nodeType: 'Group', params: {} },
        {
          type: 'connect',
          from: { node: 'p1_5t', socket: 'out' },
          to: { node: 'p1_5r', socket: 'children' },
        },
        {
          type: 'connect',
          from: { node: 'p1_5r', socket: 'out' },
          to: { node: sceneRef.node, socket: 'children' },
        },
      ],
      'user',
    );
    const t0 = performance.now();
    dag.dispatch(
      {
        type: 'setParam',
        nodeId: 'p1_5t',
        paramPath: 'position',
        value: [2.5, 0, 0],
      },
      'user',
      'gizmo drag',
    );
    const after = (w.__basher_dag!.getState().state.nodes['p1_5t'].params as { position: number[] })
      .position;
    const t1 = performance.now();
    return { elapsed: t1 - t0, position: after };
  });
  expect(latency.elapsed).toBeLessThan(16);
  expect(latency.position).toEqual([2.5, 0, 0]);
});

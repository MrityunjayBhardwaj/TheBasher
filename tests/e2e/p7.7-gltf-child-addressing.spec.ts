// P7.7 — glTF scene children → addressable DAG nodes (closes #91).
//
// The Lokāyata gate for the phase. A glTF dropped today is ONE GltfAsset node;
// its scene children (meshes, empties, bones) were name-addressed proxies the
// gizmo/NPanel/keyframe path could not reach. Waves A–D made each scene child a
// real, selectable, gizmo-addressable GltfChild DAG node WITHOUT regressing
// #88's real skin deformation. This spec PROVES that by OBSERVATION — never by
// reading the Op log:
//
//   (a) one GltfChild DAG node per scene child after import (count GltfChild
//       nodes === json.nodes count for the fixture = 3: Bone1, Bone0, SkinnedBar).
//   (b) the outliner shows the child rows under the GltfAsset; clicking a child
//       row sets primaryNodeId to that GltfChild id and the gizmo MOUNTS
//       (window.__basher_gizmo non-null).
//   (c) a gizmo drag emits a setParam on the child node (the param value changes
//       in the store) AND the `overridden` flag flips AND — explicitly — the
//       override VISIBLY PERSISTS on the rendered surface after release with NO
//       SNAP-BACK. This is the headline that proves B2's subscribed selector
//       (useDagStore((s) => s.state.nodes), SceneFromDAG.tsx:564) actually
//       re-fired the renderer; a getState() snapshot read would snap back here.
//   (d) the SkinnedMesh STILL deforms under playback — reuse the p7.6
//       window.__basher_gltf_skin vertex-delta assertion (the #88 not-regressed
//       proof — observe the moved VERTEX, not the joint TRS).
//
// Staging mirrors p7.6: the renderer loads bytes from OPFS (useResolvedAssetUrl),
// so we write the fixture bytes to OPFS AND import its structure under the SAME
// assetRef. The GltfAsset then renders the SkinnedMesh and materializes one
// GltfChild per scene child (Wave A2).
//
// REF: PLAN.md 7.7 Wave E (E1); CONTEXT 7.7 D-02; src/viewport/SceneFromDAG.tsx
// GltfAssetR (subscribed-selector + childOverridesForAsset + __basher_gltf_skin);
// src/app/Gizmo.tsx writeGltfChildOverride (the manual layer); src/app/
// sceneTreeWalk.ts projectGltfChildren; H40 boundary-pair; H45 / B12.

import { test, expect } from './_fixtures';

const ASSET_REF = 'assets/skinned-bar.glb';
const FIXTURE_URL = '/assets/skinned-bar.glb';
const TIP_VERTEX = 4; // far-end vertex weighted to Bone1 (gen-skinned-fixture.mjs)
// skinned-bar.glb has 3 json.nodes: Bone1, Bone0, SkinnedBar (gltfImportChain
// A2 unit asserts this exact set + order). One GltfChild materialized per node.
const EXPECTED_CHILD_COUNT = 3;

interface SkinHandle {
  boneCount: number;
  bound: boolean;
  vertex: (i: number) => [number, number, number];
}
interface DagNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, DagNode>; outputs: { scene?: { node: string } } };
      dispatch: (op: unknown) => void;
      dispatchAtomic?: (ops: unknown[], source?: string, label?: string) => void;
    };
  };
  __basher_importGltf?: (
    buffer: ArrayBuffer,
    assetRef: string,
  ) => Promise<{ gltfAssetId: string; transformClipIds: string[] }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_time?: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinHandle | null;
  __basher_gizmo?: () => {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  } | null;
  __basher_gizmo_grab?: (
    mode: 'translate' | 'rotate' | 'scale',
    target: [number, number, number],
  ) => void;
  __basher_selection?: { getState: () => { select: (id: string | null) => void } };
  __basher_chrome?: {
    getState: () => { setLeftSidebarCollapsed: (v: boolean) => void };
  };
}

/** Stage the fixture: bytes → OPFS, structure → DAG, then wait for the rendered
 *  SkinnedMesh seam to register (p7.6 stageSkinnedBar verbatim). */
async function stageSkinnedBar(page: import('@playwright/test').Page) {
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
      return Boolean(w.__basher_gltf_skin && w.__basher_gltf_skin() !== null);
    },
    { timeout: 15_000 },
  );
}

/** Drive REAL render time and let the mounted scene repaint (2 rAFs) so the
 *  bone-matrix palette / child override re-applies before the next read. */
async function settleRenderTime(page: import('@playwright/test').Page, seconds: number) {
  await page.evaluate((s) => {
    (window as unknown as BasherWindow).__basher_time!.getState().setTime(s);
  }, seconds);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** Let the scene repaint without changing time (for override re-apply reads). */
async function settleFrames(page: import('@playwright/test').Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

function gltfChildNodes(page: import('@playwright/test').Page): Promise<DagNode[]> {
  return page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    return Object.values(nodes).filter((n) => n.type === 'GltfChild');
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Fresh OPFS so the writeOpfsBytes staging is the only source of the asset.
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
    return Boolean(
      w.__basher_importGltf &&
      w.__basher_writeOpfsBytes &&
      w.__basher_time &&
      w.__basher_selection &&
      w.__basher_chrome,
    );
  });
});

test('P7.7 E1a — one GltfChild DAG node per scene child after import', async ({ page }) => {
  await stageSkinnedBar(page);

  const children = await gltfChildNodes(page);
  // Observation: the DAG store carries exactly one GltfChild per json.nodes
  // entry (NOT inferred from the Op log — read the materialized node table).
  expect(children).toHaveLength(EXPECTED_CHILD_COUNT);

  const names = children.map((c) => c.params.childName as string).sort();
  expect(names).toEqual(['Bone0', 'Bone1', 'SkinnedBar']);
  // Each child is bound to this asset (the by-name override key).
  for (const c of children) {
    expect(c.params.assetRef).toBe(ASSET_REF);
  }
});

test('P7.7 E1b — clicking a child outliner row selects the GltfChild and mounts the gizmo', async ({
  page,
}) => {
  await stageSkinnedBar(page);

  // The left sidebar defaults collapsed (chromeStore); expand it so the Scene
  // tree rows are reachable (the D2 / p21 harness pattern).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_chrome!.getState().setLeftSidebarCollapsed(false);
  });

  // Pick the SkinnedBar child (a mesh — has all three transform params, so the
  // gizmo manip mounts cleanly) and its owning GltfAsset id from the store.
  const ids = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    const childId =
      Object.values(nodes).find(
        (n) => n.type === 'GltfChild' && n.params.childName === 'SkinnedBar',
      )?.id ?? null;
    const assetId = Object.values(nodes).find((n) => n.type === 'GltfAsset')?.id ?? null;
    return { childId, assetId };
  });
  const { childId, assetId } = ids;
  expect(childId).toBeTruthy();
  expect(assetId).toBeTruthy();

  // D2: the GltfAsset child subtree is COLLAPSED by default (the D-05 node-flood
  // toggle, SceneTree.tsx:31/139). The child rows are hidden until the asset's
  // expand chevron is clicked. Expand it so the SkinnedBar row is reachable.
  const assetRow = page.getByTestId(`scene-tree-row-${assetId}`);
  await expect(assetRow).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`scene-tree-toggle-${assetId}`).click();

  // The child row is now projected under the GltfAsset (sceneTreeWalk
  // projectGltfChildren → row testid scene-tree-row-${childNodeId}).
  const row = page.getByTestId(`scene-tree-row-${childId}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText('SkinnedBar');

  // Click → selection lands on the GltfChild id.
  await row.click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as BasherWindow;
        // primaryNodeId is the inspector header source; observe the inspector
        // text (the rendered surface) rather than the store internals.
        return w.__basher_dag.getState().state.nodes; // touch to keep API stable
      }),
    )
    .toBeTruthy();
  await expect(page.getByTestId('inspector')).toContainText(childId!);

  // The gizmo MOUNTS for the selected child (the dev seam getter is non-null
  // once the manip proxy is attached to the GltfChild).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as BasherWindow;
        return w.__basher_gizmo ? w.__basher_gizmo() !== null : false;
      }),
    )
    .toBe(true);
});

test('P7.7 E1c — gizmo drag writes setParam + flips overridden + PERSISTS with no snap-back', async ({
  page,
}) => {
  await stageSkinnedBar(page);

  // Select the SkinnedBar child via the store seam (the selection path E1b
  // proves through the row; here we exercise the write path directly).
  const childId = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag.getState().state.nodes;
    const child = Object.values(nodes).find(
      (n) => n.type === 'GltfChild' && n.params.childName === 'SkinnedBar',
    );
    if (child) w.__basher_selection!.getState().select(child.id);
    return child?.id ?? null;
  });
  expect(childId).toBeTruthy();

  // Wait for the gizmo to mount over the selected child.
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_gizmo && w.__basher_gizmo() !== null);
  });

  // Record the child's translate BEFORE the grab + its overridden flag.
  const before = await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const n = w.__basher_dag.getState().state.nodes[id];
    return {
      position: n.params.position as number[],
      overridden: (n.params.overridden as Record<string, boolean>)?.position ?? false,
    };
  }, childId!);

  // The REAL gizmo grab path (Gizmo.tsx __basher_gizmo_grab → onObjectChange →
  // routeAnimatedGrab returns false on a GltfChild → writeGltfChildOverride →
  // ONE atomic dispatch of {position, overridden.position}).
  await page.evaluate(() => {
    (window as unknown as BasherWindow).__basher_gizmo_grab!('translate', [3, 0, 0]);
  });

  // Op side of the boundary: the store value changed AND the flag flipped.
  const after = await page.evaluate((id) => {
    const w = window as unknown as BasherWindow;
    const n = w.__basher_dag.getState().state.nodes[id];
    return {
      position: n.params.position as number[],
      overridden: (n.params.overridden as Record<string, boolean>)?.position ?? false,
    };
  }, childId!);
  expect(after.position[0]).toBeCloseTo(3, 3);
  expect(after.position).not.toEqual(before.position);
  expect(before.overridden).toBe(false);
  expect(after.overridden).toBe(true); // the C2 anti-snap-back flag flipped

  // THE HEADLINE — render-surface persistence with NO snap-back. The subscribed
  // selector (SceneFromDAG.tsx:564) must have re-fired the per-child effect so
  // the cloned child Object3D now sits at the overridden x. Read the actual
  // rendered SkinnedMesh vertex (the surface), let two frames pass to absorb any
  // re-layer, and assert it MOVED ~3 in x and STAYS there (a getState() snapshot
  // read would have let the clip/base re-win and snap back to x≈0 here).
  await settleFrames(page);
  const p1 = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );
  // Wait several more frames — if the renderer were reading a snapshot, the next
  // re-layer would revert the override; with the subscribed selector it holds.
  await settleFrames(page);
  await settleFrames(page);
  const p2 = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );

  // The vertex moved by the override in world x (the child was shifted +3).
  expect(p1[0], `override not visible on rendered surface (x=${p1[0]})`).toBeGreaterThan(2);
  // And it did NOT snap back across the extra frames (persistence — within fp).
  const drift = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
  expect(drift, `override snapped back / drifted (drift=${drift})`).toBeLessThan(0.01);
});

test('P7.7 E1d — the SkinnedMesh STILL deforms under playback (#88 not regressed)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await stageSkinnedBar(page);

  // p7.6 B3 verbatim: a skin-bound vertex moves between t=0 and t=mid. This is
  // the #88 acceptance — observe the deformed VERTEX, not the joint TRS.
  await settleRenderTime(page, 0);
  const p0 = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );
  await settleRenderTime(page, 0.9);
  const pMid = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!().vertex(i),
    TIP_VERTEX,
  );

  const delta = Math.hypot(pMid[0] - p0[0], pMid[1] - p0[1], pMid[2] - p0[2]);
  expect(delta, `tip vertex barely moved (delta=${delta}); skin did not deform`).toBeGreaterThan(
    0.2,
  );

  const relevant = errors.filter((e) => /gltf|three|skeleton|skin|loader|draco/i.test(e));
  expect(relevant, `unexpected loader/skin console errors: ${relevant.join('\n')}`).toHaveLength(0);
});

test('P7.7 E2 determinism — two drops of the fixture → identical GltfChild ids (V22)', async ({
  page,
}) => {
  // First drop.
  await stageSkinnedBar(page);
  const idsA = (await gltfChildNodes(page)).map((c) => c.id).sort();
  expect(idsA).toHaveLength(EXPECTED_CHILD_COUNT);

  // Reset OPFS + reload → a clean second drop of the SAME bytes under the SAME
  // assetRef must produce byte-identical GltfChild ids (hashId, no RNG).
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
    return Boolean(w.__basher_importGltf && w.__basher_writeOpfsBytes && w.__basher_time);
  });
  await stageSkinnedBar(page);
  const idsB = (await gltfChildNodes(page)).map((c) => c.id).sort();

  // V22: deterministic ids via hashId('gltfChild', assetRef, key) — identical
  // across drops. (The byte-identical Op[] is also asserted in the A2 unit
  // gltfImportChain.test.ts:601; this is the runtime-path twin.)
  expect(idsB).toEqual(idsA);
});

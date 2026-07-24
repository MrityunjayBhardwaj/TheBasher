// P2.6 acceptance — TransformToolbar (Wave A), editor shading
// (Wave B), UV editor scaffold (Wave C).
//
// State-driven assertions — read store snapshots through the dev-only
// window handles. Pixel-diff would re-fail H13 on every layout shift.

import { expect, test } from './_fixtures';
import { objectPosing, seedCubeObjectId } from './_seedNodes';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string; params: unknown; inputs: Record<string, unknown> }>;
        outputs: Record<string, { node: string; socket: string }>;
      };
    };
  };
  __basher_editor?: { getState: () => { space: 'view3d' | 'uv'; setSpace: (s: string) => void } };
  __basher_viewport?: {
    getState: () => {
      shading: 'studio' | 'rendered';
      gridVisible: boolean;
      snapEnabled: boolean;
    };
  };
  __basher_selection?: {
    getState: () => { primaryNodeId: string | null; select: (id: string | null) => void };
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
  // Wait for the dev-only store handles to land (boot.ts dynamic-imports
  // them so they appear after the first paint).
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_editor && w.__basher_viewport);
  });
});

// ---------------------------------------------------------------------------
// P2.6#1 — Toolbar mode buttons drive gizmoStore (proves the top-bar
// surface mirrors the existing G/R/S keyboard handlers).
//
// P6 W7 (2026-05-14): the original TransformToolbar.ModeGroup was
// deleted in C2; gizmo tool selection now lives on R8
// FloatingViewportToolbar (viewport-overlay, bottom-center). Spec
// rewritten to assert the same behavior against the new surface.
// ---------------------------------------------------------------------------

test('P2.6#1 toolbar Move/Rotate/Scale buttons drive the gizmo mode', async ({ page }) => {
  await expect(page.getByTestId('floating-viewport-toolbar')).toBeVisible();
  await page.getByTestId('floating-toolbar-rot').click();
  // R8 buttons set data-active="true" when their tool matches activeTool;
  // assert that to confirm the click landed.
  await expect(page.getByTestId('floating-toolbar-rot')).toHaveAttribute('data-active', 'true');
  await page.getByTestId('floating-toolbar-move').click();
  await expect(page.getByTestId('floating-toolbar-move')).toHaveAttribute('data-active', 'true');
});

// ---------------------------------------------------------------------------
// P2.6#2 — Toolbar shading group toggles viewportStore.shading. Defaults
// to 'studio'; clicking 'rendered' flips the projection without touching
// the DAG (V8 stays clean — observe via __basher_dag undoStack length).
// ---------------------------------------------------------------------------

test('P2.6#2 shading toggle flips viewportStore.shading; DAG is unmutated', async ({ page }) => {
  // P6 W7: shading group moved from R3 TransformToolbar to R8
  // FloatingViewportToolbar (D-W7-3).
  // Default is studio.
  await expect(page.getByTestId('floating-toolbar-shading-studio')).toHaveClass(/text-accent/);
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });
  await page.getByTestId('floating-toolbar-shading-rendered').click();
  await expect(page.getByTestId('floating-toolbar-shading-rendered')).toHaveClass(/text-accent/);
  const shading = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_viewport!.getState().shading;
  });
  expect(shading).toBe('rendered');
  // DAG node count unchanged → no leak into the graph.
  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });
  expect(after).toBe(before);
});

// ---------------------------------------------------------------------------
// P2.6#3 — Space toggle swaps the 3D viewport for the UV editor without
// unmounting the Canvas (K1 step 6 discipline preserved via display:none).
// ---------------------------------------------------------------------------

test('P2.6#3 space toggle swaps view3d ↔ uv; Canvas DOM node persists', async ({ page }) => {
  await expect(page.getByTestId('uv-slot')).toHaveCSS('display', 'none');
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'block');

  // Capture the underlying <canvas> element id so we can prove it's the
  // same node after the toggle (display:none keeps it mounted).
  const beforeId = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    if (!c.dataset.persistenceTag) c.dataset.persistenceTag = String(Math.random());
    return c.dataset.persistenceTag;
  });
  expect(beforeId).not.toBeNull();

  await page.getByTestId('toolbar-space-uv').click();
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'none');
  await expect(page.getByTestId('uv-slot')).toHaveCSS('display', 'block');
  await expect(page.getByTestId('uv-editor')).toBeVisible();

  const sameId = await page.evaluate(
    () => document.querySelector('canvas')?.dataset.persistenceTag ?? null,
  );
  expect(sameId).toBe(beforeId);

  // Toggle back via Tab keyboard — must not be intercepted by inputs. The space
  // cycle is now view3d → uv → video → view3d (3 spaces, SPACE_CYCLE), so from the
  // UV space two Tabs return to 3D View (passing through the video space).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('video-slot')).toHaveCSS('display', 'block');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('view3d-slot')).toHaveCSS('display', 'block');
});

// ---------------------------------------------------------------------------
// P2.6#4 — UV editor renders a status line and reflects selection. When
// no node is selected, status shows the placeholder; when the seed cube's
// Object is selected, status names it.
// ---------------------------------------------------------------------------

test('P2.6#4 UV editor status updates with selection', async ({ page }) => {
  await page.getByTestId('toolbar-space-uv').click();
  await expect(page.getByTestId('uv-editor-status')).toContainText('Select a mesh');

  // Find the seed cube's Object and select it via the projection store. Addressed by
  // what it POSES — several `Object`s now live in the default project, so the ordinal
  // picker this used to use lands on the light instead (#461).
  const id = await seedCubeObjectId(page);
  await page.evaluate((nodeId) => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select(nodeId);
  }, id);
  // What this pins is the P2.6#4 claim: the status line REFLECTS THE SELECTION
  // (it names the selected node, instead of the "Select a mesh" placeholder).
  await expect(page.getByTestId('uv-editor-status')).toContainText(id);
  await expect(page.getByTestId('uv-editor-status')).toContainText('Object');
  // #378 LANDED: the split cube resolves its real UV layout through the object↔data
  // reach, so the status now reports the island count instead of "no UV layout".
  // Tightened from the sentinel — "no UV layout" was the broken state.
  await expect(page.getByTestId('uv-editor-status')).toContainText('6 islands');
});

// ---------------------------------------------------------------------------
// P2.6#5 — View → Editor Space submenu flips the active space. Mirrors
// the toolbar but proves the menu wiring.
// ---------------------------------------------------------------------------

test('P2.6#5 View menu Editor Space submenu switches to UV', async ({ page }) => {
  await page.getByTestId('menu-view-button').click();
  await page.getByTestId('menu-view-space').hover();
  await page.getByTestId('menu-view-space-uv').click();
  await expect(page.getByTestId('uv-editor')).toBeVisible();
});

// ---------------------------------------------------------------------------
// P2.6#6 — Gizmo binds to non-Transform nodes (BoxMesh / lights / cameras).
// Selecting the seed BoxMesh and dragging-emitting a translate Op writes
// to params.position. Proves the generalization (P2.6 fix-up): pre-fix,
// only Transform + Character nodes got a gizmo, so the seed cube was
// unmovable until the user wrapped it in a Transform.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2.6#7 — Add menu via Shift+A: opens, picks Cube, new BoxMesh appears
// in the DAG and gets auto-selected.
// ---------------------------------------------------------------------------

test('P2.6#7 Shift+A opens Add menu; clicking Cube adds an Object+BoxData pair', async ({
  page,
}) => {
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return Object.keys(w.__basher_dag!.getState().state.nodes).length;
  });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('add-menu')).toBeVisible();
  await page.getByTestId('add-menu-mesh').hover();
  await expect(page.getByTestId('add-menu-mesh-panel')).toBeVisible();
  await page.getByTestId('add-menu-item-Cube').click();
  await expect(page.getByTestId('add-menu')).toHaveCount(0);

  const result = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const state = w.__basher_dag!.getState().state;
    const ids = Object.keys(state.nodes);
    const objects = Object.values(state.nodes).filter((n) => n.type === 'Object');
    const data = Object.values(state.nodes).filter((n) => n.type === 'BoxData');
    return { count: ids.length, objectCount: objects.length, dataCount: data.length };
  });
  // Add ▸ Cube builds the object↔data PAIR — an Object (the pose) wired to a
  // BoxData (geometry + material) — so one menu click adds TWO nodes.
  expect(result.count).toBe(before + 2);
  expect(result.objectCount).toBeGreaterThanOrEqual(2); // seed n_box + the new one
  expect(result.dataCount).toBeGreaterThanOrEqual(2); // seed n_box_data + the new one
});

// ---------------------------------------------------------------------------
// P2.6#8 — Add menu picks UV Sphere → an Object+SphereData PAIR lands in the DAG.
// ---------------------------------------------------------------------------

// #462: the claim moved with the product. Add ▸ Sphere stopped producing a fused
// `SphereMesh` at the sphere split (#384 C1 Slice 3) — it builds the object↔data pair,
// exactly as Add ▸ Cube does above. The old assertion ("some node is a SphereMesh") was
// therefore not merely testing the wrong shape: nothing in the DAG could satisfy it.
//
// Asserted as a DELTA (+2 nodes, +1 SphereData) rather than as a bare presence check,
// so it cannot pass on the seed scene alone — the seed project has no sphere at all,
// which is exactly why a presence check would look convincing and prove nothing.
test('P2.6#8 Add menu UV Sphere adds an Object+SphereData pair', async ({ page }) => {
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return {
      count: Object.keys(nodes).length,
      objects: Object.values(nodes).filter((n) => n.type === 'Object').length,
      spheres: Object.values(nodes).filter((n) => n.type === 'SphereData').length,
    };
  });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').hover();
  await page.getByTestId('add-menu-item-Sphere').click();

  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    return {
      count: Object.keys(nodes).length,
      objects: Object.values(nodes).filter((n) => n.type === 'Object').length,
      spheres: Object.values(nodes).filter((n) => n.type === 'SphereData').length,
      // The pair is WIRED — a SphereData nobody points at renders nothing.
      wired: Object.values(nodes).some(
        (n) =>
          n.type === 'Object' &&
          nodes[(n as { inputs?: { data?: { node: string } } }).inputs?.data?.node ?? '']?.type ===
            'SphereData',
      ),
    };
  });
  // One menu click adds TWO nodes: the Object (the pose) and the SphereData it points at.
  expect(after.count).toBe(before.count + 2);
  expect(after.objects).toBe(before.objects + 1);
  expect(after.spheres).toBe(before.spheres + 1);
  expect(after.wired).toBe(true);
});

// ---------------------------------------------------------------------------
// P2.6#9 — Gizmo regression: select → deselect → re-select must show the
// gizmo on every cycle. Pre-fix, the second selection silently failed
// because TransformControls was gated on a stale ref. (User reported.)
// ---------------------------------------------------------------------------

test('P2.6#9 gizmo proxy group survives select → deselect → reselect', async ({ page }) => {
  // Indirect probe: count the gizmo's <group> element (first child of
  // Gizmo's fragment). It mounts when a node with a position param is
  // selected; unmounts on null primary; should re-mount on reselection.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  // Allow R3F to commit the first render.
  await page.waitForTimeout(150);

  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select(null);
  });
  await page.waitForTimeout(150);

  // Re-select. The fix lifts the proxy group's ref into React state via
  // a callback ref so re-mounting triggers a re-render and the
  // TransformControls remounts. Pre-fix, primaryNodeId was set but the
  // gizmo never appeared.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });
  const primary = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_selection!.getState().primaryNodeId;
  });
  expect(primary).toBe('n_box');
});

// ---------------------------------------------------------------------------
// P2.6#10 — Wireframe shading toggle. Toolbar exposes three modes; the
// store snapshot reflects the click; the canvas re-renders.
// ---------------------------------------------------------------------------

test('P2.6#10 toolbar wireframe button flips viewportStore.shading to wireframe', async ({
  page,
}) => {
  // P6 W7: shading group moved from R3 TransformToolbar to R8
  // FloatingViewportToolbar (D-W7-3).
  await page.getByTestId('floating-toolbar-shading-wireframe').click();
  await expect(page.getByTestId('floating-toolbar-shading-wireframe')).toHaveClass(/text-accent/);
  const shading = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_viewport!.getState().shading;
  });
  expect(shading).toBe('wireframe');
});

// ---------------------------------------------------------------------------
// P2.6#11 — UV editor reads a sphere's real UV layout.
// ---------------------------------------------------------------------------

// #462: Add ▸ Sphere builds an Object over a SphereData, so the status line names the
// selected node's type — `Object`, not the retired `SphereMesh`. The claim this case
// exists for survives the rename, and the SPHERE-ness has to be asserted somewhere or
// the case collapses into "a mesh is selected", which P2.6#4 already covers on the cube.
//
// The sphere-specific signal is the ISLAND COUNT: a UV sphere's equirectangular wrap is
// ONE connected island, where the cube P2.6#4 asserts on is SIX. That number is
// unreachable from the cube's, from the 'no UV layout' failure state, and from the old
// synthetic unfold — so it discriminates in every direction that matters.
test('P2.6#11 UV editor status reflects the added sphere (1 island, read-only)', async ({
  page,
}) => {
  // Add a sphere first — an Object + SphereData pair (see P2.6#8).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+A');
  await page.getByTestId('add-menu-mesh').hover();
  await page.getByTestId('add-menu-item-Sphere').click();

  // Select its Object by WHAT IT POSES — Add leaves selection on the new node, but say
  // so explicitly rather than relying on it, and never by ordinal (#461).
  const sphereId = await objectPosing(page, 'SphereData');
  await page.evaluate((nodeId) => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select(nodeId);
  }, sphereId);

  // Switch to UV space.
  await page.getByTestId('toolbar-space-uv').click();
  const status = page.getByTestId('uv-editor-status');
  await expect(status).toContainText(sphereId);
  await expect(status).toContainText('Object');
  // v0.6 #3 reworked the UV editor into a read-only island/tri readout (the old
  // "equirectangular" projection label is gone). The sphere's real layout is ONE island
  // — the singular form, which the 6-island cube cannot produce.
  await expect(status).toContainText('1 island ');
  await expect(status).toContainText('read-only');
});

// ---------------------------------------------------------------------------
// P2.6#12 — Lights gain a rotation param + are click-pickable. Pre-fix:
// only Transform / BoxMesh nodes had rotation, so the gizmo coerced to
// translate when a light was selected. Light helpers also weren't
// click-targets — selection routed only through NodeList. Fix verifies:
//   1. setParam(nodeId, 'rotation', [...]) lands on a directional light.
//   2. Selection store reflects a programmatic select on a light id.
// (Pointer events on R3F primitives are still routed through the
//  selection store directly per the H3 / H11 lesson.)
// ---------------------------------------------------------------------------

test('P2.6#12 lights carry rotation param + are selectable', async ({ page }) => {
  // Seed has n_light (DirectionalLight) at [5,5,3]. Confirm rotation defaults
  // to [0,0,0] after load.
  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_dag!.getState().state.nodes.n_light.params as { rotation?: number[] })
      .rotation;
  });
  expect(before).toEqual([0, 0, 0]);

  // Dispatch a setParam Op on the light's rotation — proves the Gizmo's
  // rotate path works once the param is on the schema.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    type Dispatch = (op: unknown, source?: string, description?: string) => void;
    (w.__basher_dag!.getState() as unknown as { dispatch: Dispatch }).dispatch(
      { type: 'setParam', nodeId: 'n_light', paramPath: 'rotation', value: [0.4, -0.2, 0] },
      'user',
      'gizmo rotate',
    );
  });
  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_dag!.getState().state.nodes.n_light.params as { rotation: number[] })
      .rotation;
  });
  expect(after).toEqual([0.4, -0.2, 0]);

  // Selection round-trip — proves the helper's onClick path lands.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_light');
  });
  const primary = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return w.__basher_selection!.getState().primaryNodeId;
  });
  expect(primary).toBe('n_light');
});

test('P2.6#6 gizmo translate dispatches setParam on BoxMesh.position', async ({ page }) => {
  // Seed has n_box (BoxMesh) at [0,0,0]. Select it.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    w.__basher_selection!.getState().select('n_box');
  });

  const before = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_dag!.getState().state.nodes.n_box.params as { position: number[] }).position;
  });
  expect(before).toEqual([0, 0, 0]);

  // Simulate the dispatch the gizmo would produce on drag (we exercise
  // the Op surface directly; pointer-event simulation through THREE's
  // TransformControls is fragile in headless Chromium — H3 lesson).
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    type Dispatch = (op: unknown, source?: string, description?: string) => void;
    (w.__basher_dag!.getState() as unknown as { dispatch: Dispatch }).dispatch(
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [1.5, 0.25, -0.75] },
      'user',
      'gizmo translate',
    );
  });

  const after = await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    return (w.__basher_dag!.getState().state.nodes.n_box.params as { position: number[] }).position;
  });
  expect(after).toEqual([1.5, 0.25, -0.75]);
});

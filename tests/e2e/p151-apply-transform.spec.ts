// p151 (Apply-Transform) Wave 2 — the PRIMITIVES ship gate (issue #151).
//
// A director Applies a primitive end-to-end: the TRS bakes into geometry, the node
// becomes a BakedMesh (identity transform), it renders, persists, and is one undo.
// Every assertion observes the REAL state (rendered three.js bounds, real node type)
// — not inference.
//
// #365 Slice 2: the Apply MECHANISM is exercised on a fused SphereMesh, not the
// retired fused BoxMesh. Apply on a split cube (an Object) is the still-open #376 gap
// — dispatchApplyTransform gates on `SphereMesh` (:196), so an Object is rejected
// until a bake path for a posed Object+BoxData lands. A radius-0.5 sphere has a
// 1×1×1 bbox, so scale=[2,1,1] still bakes to bounds 2×1×1 — the numeric assertions
// are unchanged. The split-cube rejection is pinned as its own #376 sentinel below.
//
// SC-1  Sphere scale=[2,1,1] → BakedMesh, transform.scale==[1,1,1], world bounds 2×1×1.
// SC-2  boundary-pair (H40): rendered world bounds == resolver geometry bounds.
// SC-3  reload → BakedMesh still renders, bounds identical.
// SC-5  Apply → Cmd+Z → original SphereMesh id+type+scale+edges restored.
// SC-8  keyframe position → Apply menu disabled + message.
// H45   two same-size Spheres, bake one → the other unchanged.
// #376  a split cube (Object) is NOT bakeable — Apply is rejected, no BakedMesh.
//
// REF: PLAN.md Wave 2 Task 6; hetvabhasa H40/H45; vyapti V1/V20; CONTEXT D-04; #376.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
      dispatchAtomic: (ops: unknown[], source?: string, description?: string) => unknown;
      undo: () => void;
    };
  };
  __basher_mesh_world_bounds?: (nodeId: string) => [number, number, number] | null;
  __basher_baked_geometry_bounds?: (nodeId: string) => [number, number, number] | null;
}

function bw(page: import('@playwright/test').Page) {
  return page as unknown as import('@playwright/test').Page;
}

async function nodeOfType(page: import('@playwright/test').Page, type: string) {
  return page.evaluate((t) => {
    const w = window as unknown as BasherWindow;
    const nodes = w.__basher_dag!.getState().state.nodes;
    const entry = Object.entries(nodes).find(([, n]) => n.type === t);
    return entry ? { id: entry[0], params: entry[1].params } : null;
  }, type);
}

async function setScale(page: import('@playwright/test').Page, id: string, scale: number[]) {
  await page.evaluate(
    ({ nodeId, value }) => {
      (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
        type: 'setParam',
        nodeId,
        paramPath: 'scale',
        value,
      });
    },
    { nodeId: id, value: scale },
  );
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
    return Boolean(
      w.__basher_dag && w.__basher_mesh_world_bounds && w.__basher_baked_geometry_bounds,
    );
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_box') !== null,
  );
});

/** Apply via the live DAG dispatch path the menu/NPanel call into — the dynamic
 *  import keeps the e2e off the React render order while exercising the same
 *  helper. */
async function applyTransform(page: import('@playwright/test').Page, id: string, mask: string) {
  return page.evaluate(
    async ({ nodeId, m }) => {
      const mod = await import('/src/app/animate/dispatchApplyTransform.ts');
      return (await mod.dispatchApplyTransform(nodeId, m)) as { ok: boolean; reason?: string };
    },
    { nodeId: id, m: mask },
  );
}

/** Inject a fused SphereMesh (radius 0.5 → 1×1×1 bbox) wired into the scene and
 *  wait for it to render. The Apply MECHANISM runs on this working producer; a split
 *  cube (Object) is the #376 gap, pinned separately. Returns the node id. */
async function seedApplySphere(page: import('@playwright/test').Page, id: string) {
  await page.evaluate((nodeId) => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag!.getState();
    const nodes = dag.state.nodes;
    const sceneId = Object.entries(nodes).find(([, n]) => n.type === 'Scene')![0];
    dag.dispatchAtomic([
      {
        type: 'addNode',
        nodeId,
        nodeType: 'SphereMesh',
        params: { radius: 0.5, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        type: 'connect',
        from: { node: nodeId, socket: 'out' },
        to: { node: sceneId, socket: 'children' },
      },
    ]);
  }, id);
  await page.waitForFunction(
    (nodeId) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(nodeId) !== null,
    id,
  );
}

test.describe('p151 Wave 2 — Apply a primitive end-to-end', () => {
  test('SC-1 + SC-2: Sphere scale=[2,1,1] Apply → BakedMesh identity, bounds 2×1×1, rendered==resolver', async ({
    page,
  }) => {
    await seedApplySphere(page, 'n_apply');
    await setScale(page, 'n_apply', [2, 1, 1]);
    await page.waitForFunction(() => {
      const r = (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_apply');
      return r !== null && Math.abs(r[0] - 2) < 1e-3;
    });

    await applyTransform(page, 'n_apply', 'all');

    // The original Sphere is gone; a BakedMesh exists with identity transform.
    await page.waitForFunction(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return !nodes['n_apply'] && Object.values(nodes).some((n) => n.type === 'BakedMesh');
    });
    const baked = await nodeOfType(page, 'BakedMesh');
    expect(baked).not.toBeNull();
    expect(baked!.params.scale).toEqual([1, 1, 1]);
    expect(baked!.params.position).toEqual([0, 0, 0]);

    // Wait for the baked geometry to load + render (suspense).
    await page.waitForFunction(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id) !== null,
      baked!.id,
    );

    // SC-1 — rendered world bounds are 2×1×1 (the baked verts carry the scale).
    const rendered = await bw(page).evaluate(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
      baked!.id,
    );
    expect(rendered).not.toBeNull();
    expect(rendered![0]).toBeCloseTo(2, 2);
    expect(rendered![1]).toBeCloseTo(1, 2);
    expect(rendered![2]).toBeCloseTo(1, 2);

    // SC-2 — boundary-pair (H40): rendered world bounds == resolver geometry bounds.
    const resolverBounds = await bw(page).evaluate(
      (id) => (window as unknown as BasherWindow).__basher_baked_geometry_bounds!(id),
      baked!.id,
    );
    expect(resolverBounds).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(rendered![i]).toBeCloseTo(resolverBounds![i], 3);
    }
  });

  test('SC-3: reload → the BakedMesh still renders, bounds identical', async ({ page }) => {
    await seedApplySphere(page, 'n_apply');
    await setScale(page, 'n_apply', [2, 1, 1]);
    await page.waitForFunction(() => {
      const r = (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_apply');
      return r !== null && Math.abs(r[0] - 2) < 1e-3;
    });
    await applyTransform(page, 'n_apply', 'all');
    await page.waitForFunction(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return Object.values(nodes).some((n) => n.type === 'BakedMesh');
    });
    const baked = await nodeOfType(page, 'BakedMesh');
    await page.waitForFunction(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id) !== null,
      baked!.id,
    );
    const before = await bw(page).evaluate(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
      baked!.id,
    );

    // Save then reload — the project persists to OPFS; the baked bytes must too.
    await page.evaluate(async () => {
      const boot = await import('/src/app/boot.ts');
      await boot.saveCurrent();
    });
    await page.reload();
    await expect(page.getByTestId('layout')).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(() =>
      Boolean((window as unknown as BasherWindow).__basher_mesh_world_bounds),
    );

    const reloadedBaked = await nodeOfType(page, 'BakedMesh');
    expect(reloadedBaked).not.toBeNull();
    await page.waitForFunction(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id) !== null,
      reloadedBaked!.id,
    );
    const after = await bw(page).evaluate(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
      reloadedBaked!.id,
    );
    expect(after).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(after![i]).toBeCloseTo(before![i], 3);
    }
  });

  test('SC-5: Apply → undo → the original SphereMesh (id+type+scale+edges) is restored', async ({
    page,
  }) => {
    await seedApplySphere(page, 'n_apply');
    await setScale(page, 'n_apply', [2, 1, 1]);
    await applyTransform(page, 'n_apply', 'all');
    await page.waitForFunction(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return !nodes['n_apply'] && Object.values(nodes).some((n) => n.type === 'BakedMesh');
    });

    await page.evaluate(() => (window as unknown as BasherWindow).__basher_dag!.getState().undo());

    const restored = await page.evaluate(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      const sphere = nodes['n_apply'];
      const hasBaked = Object.values(nodes).some((n) => n.type === 'BakedMesh');
      return {
        sphere: sphere ? { type: sphere.type, scale: sphere.params.scale } : null,
        hasBaked,
      };
    });
    expect(restored.sphere).not.toBeNull();
    expect(restored.sphere!.type).toBe('SphereMesh');
    expect(restored.sphere!.scale).toEqual([2, 1, 1]);
    // The BakedMesh is gone (the addNode inverse removed it).
    expect(restored.hasBaked).toBe(false);
    // The original edge is restored — the Sphere renders again.
    await page.waitForFunction(
      () => (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_apply') !== null,
    );
  });

  test('SC-8: a keyframed-position Sphere → Object ▸ Apply submenu disabled + message', async ({
    page,
  }) => {
    await seedApplySphere(page, 'n_apply');
    // Keyframe the sphere position → animated transform (D-04). (A bakeable primitive,
    // so the disabled state is the ANIMATED guard, not the not-bakeable one.)
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      w.__basher_dag!.getState().dispatch({
        type: 'addNode',
        nodeId: 'kf_pos',
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'pos',
          target: 'n_apply',
          paramPath: 'position',
          keyframes: [{ time: 0, value: [0, 0, 0], easing: 'linear' }],
        },
      });
    });
    // Select the sphere so the Object menu targets it.
    await page.evaluate(async () => {
      const m = await import('/src/app/stores/selectionStore.ts');
      m.useSelectionStore.getState().select('n_apply');
    });

    // Open Object ▸ Apply; the items must be disabled and the message shown.
    await page.getByTestId('menu-object-button').click();
    await page.getByTestId('menu-object-apply').hover();
    await expect(page.getByTestId('menu-object-apply-animated-msg')).toBeVisible();
    await expect(page.getByTestId('menu-object-apply-all')).toBeDisabled();
  });

  test('H45 isolation: bake one of two same-size Spheres → the other is unchanged', async ({
    page,
  }) => {
    // Two unit spheres wired to the Scene; both share the registry geometry.
    await seedApplySphere(page, 'n_apply');
    await seedApplySphere(page, 'n_apply2');
    const otherBefore = await bw(page).evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_apply2'),
    );

    // Bake the FIRST sphere.
    await applyTransform(page, 'n_apply', 'all');
    await page.waitForFunction(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return Object.values(nodes).some((n) => n.type === 'BakedMesh');
    });

    // The second sphere's rendered bounds are unchanged (shared geom not corrupted).
    const otherAfter = await bw(page).evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n_apply2'),
    );
    expect(otherAfter).not.toBeNull();
    expect(otherBefore).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(otherAfter![i]).toBeCloseTo(otherBefore![i], 4);
    }
  });

  test('#376 sentinel: Apply on a split cube (Object) is rejected — no bake path yet', async ({
    page,
  }) => {
    // The default cube is a split Object. dispatchApplyTransform gates on SphereMesh
    // (:196), so an Object is refused with ok:false and NO BakedMesh is created — the
    // documented #376 gap. When a posed Object+BoxData bake path lands, this flips RED
    // and the mechanism tests above should also cover a split cube.
    await setScale(page, 'n_box', [2, 1, 1]);
    const result = await applyTransform(page, 'n_box', 'all');
    expect(result.ok).toBe(false);
    const state = await page.evaluate(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return {
        cubeStillThere: Boolean(nodes['n_box']),
        hasBaked: Object.values(nodes).some((n) => n.type === 'BakedMesh'),
      };
    });
    expect(state.cubeStillThere).toBe(true);
    expect(state.hasBaked).toBe(false);
  });
});

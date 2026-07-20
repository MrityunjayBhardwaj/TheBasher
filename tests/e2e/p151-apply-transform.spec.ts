// p151 (Apply-Transform) Wave 2 — the PRIMITIVES ship gate (issue #151).
//
// A director Applies a primitive end-to-end: the TRS bakes into geometry, the node
// becomes a BakedMesh (identity transform), it renders, persists, and is one undo.
// Every assertion observes the REAL state (rendered three.js bounds, real node type)
// — not inference.
//
// #365 Slice 2: the Apply MECHANISM is exercised on a fused SphereMesh, not the
// retired fused BoxMesh. A radius-0.5 sphere has a 1×1×1 bbox, so scale=[2,1,1] bakes
// to bounds 2×1×1 — the numeric assertions carry over from the retired box verbatim.
//
// #376: a split cube (an Object posed over a BoxData) now bakes too, through the SAME
// mechanism — the gate admits `Object` alongside `SphereMesh`, and the pair retires
// together. The split-cube case below asserts the SAME numbers as SC-1, so it pins the
// mechanism rather than merely that the call stopped failing.
//
// SC-1  Sphere scale=[2,1,1] → BakedMesh, transform.scale==[1,1,1], world bounds 2×1×1.
// SC-2  boundary-pair (H40): rendered world bounds == resolver geometry bounds.
// SC-3  reload → BakedMesh still renders, bounds identical.
// SC-5  Apply → Cmd+Z → original SphereMesh id+type+scale+edges restored.
// SC-8  keyframe position → Apply menu disabled + message.
// H45   two same-size Spheres, bake one → the other unchanged.
// #376  a split cube (Object) bakes → BakedMesh identity, bounds 2×1×1, the PAIR retired.
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
 *  wait for it to render. The Apply MECHANISM runs on this working producer; the split
 *  cube bakes through the SAME mechanism and is covered by its own case below (#376).
 *  Returns the node id. */
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

  test('#411: a keyframed SIZE on a split cube → Object ▸ Apply disabled + message', async ({
    page,
  }) => {
    // The gap this closes: `size` lives on the cube's DATA node, not on the Object
    // the user selects, so the old TRS-band guard asked the wrong node, found
    // nothing, and offered a bake that silently froze the animation at frame 0.
    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag!.getState();
      const sceneId = Object.entries(dag.state.nodes).find(([, n]) => n.type === 'Scene')![0];
      dag.dispatchAtomic([
        { type: 'addNode', nodeId: 'n411_data', nodeType: 'BoxData', params: { size: [1, 1, 1] } },
        { type: 'addNode', nodeId: 'n411_obj', nodeType: 'Object', params: {} },
        {
          type: 'connect',
          from: { node: 'n411_data', socket: 'out' },
          to: { node: 'n411_obj', socket: 'data' },
        },
        {
          type: 'connect',
          from: { node: 'n411_obj', socket: 'out' },
          to: { node: sceneId, socket: 'children' },
        },
        {
          type: 'addNode',
          nodeId: 'kf_size',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'size',
            target: 'n411_data', // the DATA node — this is the reach under test
            paramPath: 'size',
            keyframes: [
              { time: 0, value: [1, 1, 1], easing: 'linear' },
              { time: 1, value: [3, 1, 1], easing: 'linear' },
            ],
          },
        },
      ]);
    });
    await page.waitForFunction(
      () => (window as unknown as BasherWindow).__basher_mesh_world_bounds!('n411_obj') !== null,
    );
    // Select the OBJECT — what a user actually clicks; the animated param is one
    // edge away on its data node.
    await page.evaluate(async () => {
      const m = await import('/src/app/stores/selectionStore.ts');
      m.useSelectionStore.getState().select('n411_obj');
    });

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

  test('#376: Apply on a split cube (Object) bakes — BakedMesh identity, bounds 2×1×1, pair retired', async ({
    page,
  }) => {
    // The #376 gap is CLOSED: the default cube is a split Object over a BoxData, and it
    // now bakes through the same mechanism as the fused sphere (SC-1). Asserted on the
    // SAME numbers as SC-1 — the unit cube scaled on X bakes to world bounds 2×1×1 — so
    // this pins the split-cube MECHANISM, not merely that the call stopped failing.
    await setScale(page, 'n_box', [2, 1, 1]);
    const dataId = await page.evaluate(() => {
      const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
      return (nodes['n_box'] as unknown as { inputs: Record<string, { node: string }> }).inputs.data
        .node;
    });

    const result = await applyTransform(page, 'n_box', 'all');
    expect(result.ok).toBe(true);

    const state = await page.evaluate(
      ([boxId, dId]) => {
        const nodes = (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes;
        const baked = Object.entries(nodes).find(([, n]) => n.type === 'BakedMesh');
        return {
          objectGone: !nodes[boxId!],
          dataGone: !nodes[dId!],
          bakedId: baked?.[0] ?? null,
          bakedScale: baked?.[1].params.scale,
          bakedPosition: baked?.[1].params.position,
        };
      },
      ['n_box', dataId],
    );

    // The PAIR retired — leaving the BoxData would orphan it in the saved graph.
    expect(state.objectGone).toBe(true);
    expect(state.dataGone).toBe(true);
    // The pose went INTO the geometry, so the baked node sits at identity…
    expect(state.bakedId).not.toBeNull();
    expect(state.bakedScale).toEqual([1, 1, 1]);
    expect(state.bakedPosition).toEqual([0, 0, 0]);
    // …and the RENDERED bounds still carry the scale (observation, not inference).
    await page.waitForFunction(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id) !== null,
      state.bakedId!,
    );
    const bounds = await page.evaluate(
      (id) => (window as unknown as BasherWindow).__basher_mesh_world_bounds!(id),
      state.bakedId!,
    );
    expect(bounds![0]).toBeCloseTo(2, 3);
    expect(bounds![1]).toBeCloseTo(1, 3);
    expect(bounds![2]).toBeCloseTo(1, 3);
  });
});

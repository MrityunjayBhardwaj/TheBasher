// p150 (v0.6 #1) Wave 3 — the H40 boundary-pair gate.
//
// THE load-bearing observation: `resolveEvaluatedMesh` (the read-side producer
// every surface consumes) and the renderer (SceneFromDAG, the viewport) must
// apply the NEW `transform.scale` band IDENTICALLY at the same ctx.time — or
// displayed ≠ rendered (the #68 class, H40). This spec observes BOTH sides:
//   Side A — the REAL three.js rendered object's WORLD scale, read by node id
//            via the DEV scene-walk seam `__basher_mesh_world_scale` (C-3).
//   Side B — `resolveEvaluatedMesh(...).transform.scale` via __basher_evaluated_mesh.
// and asserts A === B at ≥2 states (identity + [2,3,4]). Side A is the
// non-inferential half — it is the actual rendered object, NOT the node params.
//
// REF: PLAN.md Wave 3; hetvabhasa H40 / H58; vyapti V20; CONTEXT §H.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
    };
  };
  __basher_mesh_world_scale?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_mesh?: (
    nodeId: string,
    ctx?: { time: { frame: number; seconds: number; normalized: number } },
  ) => { transform: { scale: [number, number, number] } } | null;
}

async function rendered(page: import('@playwright/test').Page, id: string) {
  return page.evaluate(
    (nodeId) => (window as unknown as BasherWindow).__basher_mesh_world_scale!(nodeId),
    id,
  );
}

async function resolved(page: import('@playwright/test').Page, id: string) {
  return page.evaluate((nodeId) => {
    const m = (window as unknown as BasherWindow).__basher_evaluated_mesh!(nodeId);
    return m ? m.transform.scale : null;
  }, id);
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
  // Wait for BOTH seams: the side-B resolver (boot) AND the side-A scene-walk
  // probe (mounted inside the Canvas once the box renders).
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag && w.__basher_evaluated_mesh && w.__basher_mesh_world_scale);
  });
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box') !== null,
  );
});

test.describe('v0.6 #1 Wave 3 — renderer applies transform.scale == resolver (H40 boundary-pair)', () => {
  test('at identity: rendered world scale == resolver scale == [1,1,1] (render-invariance, C-2)', async ({
    page,
  }) => {
    // The default box's scale defaults to identity (the same value a migrated v1
    // project lands — see migrations.test.ts for the migrated-fixture half). The
    // REAL rendered object reading [1,1,1] is the render-invariance observation:
    // applying an identity scale is a no-op, so an old project renders unchanged.
    const r = await rendered(page, 'n_box');
    const s = await resolved(page, 'n_box');
    expect(r).not.toBeNull();
    expect(s).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(r![i]).toBeCloseTo(1, 5);
      expect(s![i]).toBeCloseTo(1, 5);
      expect(r![i]).toBeCloseTo(s![i], 5); // H40: rendered == resolver
    }
  });

  test('at [2,3,4]: the REAL rendered three.js scale == resolveEvaluatedMesh scale', async ({
    page,
  }) => {
    await setScale(page, 'n_box', [2, 3, 4]);
    // Wait for the render commit to flow the new scale onto the three.js object.
    await page.waitForFunction(() => {
      const r = (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box');
      return r !== null && Math.abs(r[0] - 2) < 1e-4;
    });

    const r = await rendered(page, 'n_box');
    const s = await resolved(page, 'n_box');
    expect(r).not.toBeNull();
    expect(s).not.toBeNull();
    // Side A — the real rendered object IS scaled (not inferred from params).
    expect(r![0]).toBeCloseTo(2, 4);
    expect(r![1]).toBeCloseTo(3, 4);
    expect(r![2]).toBeCloseTo(4, 4);
    // H40 — rendered == resolver, component-wise.
    expect(r![0]).toBeCloseTo(s![0], 4);
    expect(r![1]).toBeCloseTo(s![1], 4);
    expect(r![2]).toBeCloseTo(s![2], 4);
    // The geometry `size` param is UNTOUCHED — scale is a distinct band (D-01).
    const size = await page.evaluate(
      () =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_box'].params
          .size,
    );
    expect(size).toEqual([1, 1, 1]);
  });
});

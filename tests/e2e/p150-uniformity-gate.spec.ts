// p150 (v0.6 #1) Wave 4 — the VISIBLE Uniformity-gate slice (D-04 acceptance).
//
// "Scale a Box with the gizmo and it works through the same surface as glTF."
// Drag the scale gizmo on a primitive and observe, on REAL state (not inference):
//   A — the RENDERED box world scale ≈ [2,2,2]   (real three.js object)
//   B — resolveEvaluatedMesh(...).transform.scale ≈ [2,2,2]   (H40 holds)
//   C — the inspector transform-section scale field reads ≈ 2   (consumed surface)
//   D — the box `size` param is UNCHANGED — the gizmo touched the transform band,
//       not the geometry capability (the v0.6 #1 size-vs-scale distinction).
// Falsification: editing `size` changes geometry but leaves transform.scale at
// [2,2,2] — size and scale are INDEPENDENT.
//
// REF: PLAN.md Wave 4 Task 11; CONTEXT D-04; hetvabhasa H40/H58; vyapti V20.

import { test, expect } from './_fixtures';

interface BasherWindow {
  __basher_dag?: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
      dispatch: (op: unknown, source?: string, description?: string) => unknown;
    };
  };
  __basher_selection?: { getState: () => { select: (id: string) => void } };
  __basher_gizmo_grab?: (
    mode: 'translate' | 'rotate' | 'scale',
    target: [number, number, number],
  ) => void;
  __basher_mesh_world_scale?: (nodeId: string) => [number, number, number] | null;
  __basher_evaluated_mesh?: (nodeId: string) => {
    transform: { scale: [number, number, number] };
    geometry: { descriptor: { kind: string; size?: [number, number, number] } };
  } | null;
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
    return Boolean(w.__basher_dag && w.__basher_evaluated_mesh && w.__basher_mesh_world_scale);
  });
  await page.getByTestId('timeline-drawer-toggle').click();
  // Select n_box and wait for the gizmo grab seam to mount.
  await page.evaluate(() =>
    (window as unknown as BasherWindow).__basher_selection!.getState().select('n_box'),
  );
  await page.waitForFunction(() =>
    Boolean((window as unknown as BasherWindow).__basher_gizmo_grab),
  );
  await page.waitForFunction(
    () => (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box') !== null,
  );
});

test.describe('v0.6 #1 Wave 4 — gizmo scale on a Box is uniform (renders + inspector + size≠scale)', () => {
  test('scale a Box via the gizmo → renders, resolver agrees, inspector shows it, size independent', async ({
    page,
  }) => {
    // Drag the scale gizmo to 2× (Auto-Key OFF → a static setParam on `scale`,
    // the real affordance — D-01: gizmo scale writes transform.scale).
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_gizmo_grab!('scale', [2, 2, 2]),
    );
    await page.waitForFunction(() => {
      const r = (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box');
      return r !== null && Math.abs(r[0] - 2) < 1e-4;
    });

    // (A) the REAL rendered three.js object is scaled.
    const rendered = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box'),
    );
    expect(rendered![0]).toBeCloseTo(2, 4);
    expect(rendered![1]).toBeCloseTo(2, 4);
    expect(rendered![2]).toBeCloseTo(2, 4);

    // (B) the resolver agrees (H40).
    const resolved = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_evaluated_mesh!('n_box'),
    );
    expect(resolved!.transform.scale[0]).toBeCloseTo(2, 4);
    expect(resolved!.transform.scale).toEqual(rendered);

    // (C) the inspector transform-section scale field shows it (consumed surface).
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.getByTestId('inspector-section-toggle-transform').click();
    await expect(page.getByTestId('inspector-section-body-transform')).toBeVisible();
    const sx = await page.getByTestId('inspector-vec-n_box-scale-x').inputValue();
    const sy = await page.getByTestId('inspector-vec-n_box-scale-y').inputValue();
    const sz = await page.getByTestId('inspector-vec-n_box-scale-z').inputValue();
    expect(Number(sx)).toBeCloseTo(2, 3);
    expect(Number(sy)).toBeCloseTo(2, 3);
    expect(Number(sz)).toBeCloseTo(2, 3);

    // (D) the geometry `size` is UNTOUCHED — the gizmo touched the band, not the
    // capability. The mesh section still shows a DISTINCT size field (uniform TRS
    // proof: size and scale coexist as separate concepts).
    const size = await page.evaluate(
      () =>
        (window as unknown as BasherWindow).__basher_dag!.getState().state.nodes['n_box'].params
          .size,
    );
    expect(size).toEqual([1, 1, 1]);
    expect(resolved!.geometry.descriptor.size).toEqual([1, 1, 1]);
    await expect(page.getByTestId('inspector-vec-n_box-size-x')).toBeVisible();
  });

  test('falsification: editing size changes geometry but leaves transform.scale at 2×', async ({
    page,
  }) => {
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_gizmo_grab!('scale', [2, 2, 2]),
    );
    await page.waitForFunction(() => {
      const r = (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box');
      return r !== null && Math.abs(r[0] - 2) < 1e-4;
    });

    // Now edit the SEPARATE geometry capability.
    await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_dag!.getState().dispatch({
        type: 'setParam',
        nodeId: 'n_box',
        paramPath: 'size',
        value: [3, 3, 3],
      }),
    );

    const resolved = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_evaluated_mesh!('n_box'),
    );
    // geometry changed...
    expect(resolved!.geometry.descriptor.size).toEqual([3, 3, 3]);
    // ...but the transform band did NOT — size and scale are independent.
    expect(resolved!.transform.scale[0]).toBeCloseTo(2, 4);
    const rendered = await page.evaluate(() =>
      (window as unknown as BasherWindow).__basher_mesh_world_scale!('n_box'),
    );
    expect(rendered![0]).toBeCloseTo(2, 4); // rendered scale unchanged by a size edit
  });
});

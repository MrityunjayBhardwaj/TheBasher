// v0.6 #3 (#181, W1) — REAL UV display.
//
// THE FEATURE: the UVEditor shows the REAL UV layout of any mesh, extracted from
// the actual BufferGeometry (resolver for box/sphere; the stored mesh for an import), via
// the ONE `resolveMeshUVs`/`extractUVIslands`. NOT the old synthetic Box/Sphere
// unfold (uvLayout.ts).
//
// THE PROOF (Lokayata, H40 boundary-pair — side A is the REAL geometry):
//   three.js BoxGeometry maps EVERY face to the FULL [0,1] UV square → 6 islands,
//   each bound [0,0,1,1]. The OLD synthetic "cross unfold" placed faces in
//   distinct SUB-regions (e.g. [0,0.33,0.25,0.66]) — so real and synthetic CANNOT
//   both pass the bounds assertion. The seam reads THROUGH the same resolveMeshUVs
//   the panel draws (no drift).
//
// FALSIFICATION (run once, then revert — see the wave log):
//   point UVEditor/resolveMeshUVs back at generateBoxUVs() (synthetic) → SC-1's
//   per-island [0,0,1,1] bounds assertion FAILS (synthetic bounds are sub-regions).

import { test, expect } from './_fixtures';
import { firstMaterialMesh } from './_importedMesh';
import { splitSphereOps } from './_splitSphere';

const FIXTURE = 'two-material-textured-quad.gltf';

interface UVIslandsResult {
  status: string;
  islandCount: number;
  triangleCount: number;
  bounds: [number, number, number, number] | null;
  sampled: boolean;
}
interface Op {
  type: string;
  [k: string]: unknown;
}
interface BasherWindow {
  __basher_uv_islands?: (nodeId: string) => UVIslandsResult;
  __basher_dag: {
    getState: () => {
      state: {
        nodes: Record<string, { type: string }>;
        outputs: { scene?: { node: string } };
      };
      dispatchAtomic: (ops: Op[], source?: string, label?: string) => void;
    };
  };
  __basher_ingestGltfFolder?: (
    files: { relativePath: string; bytes: Uint8Array }[],
    folderName: string,
  ) => Promise<string>;
}

test.describe('v0.6 #3 W1 — real UV display', () => {
  // #378 LANDED — the split cube resolves its REAL UV layout through the object↔data
  // reach. This was the sentinel that asserted 'none' while `resolveMeshUVs` had no
  // Object branch; the reach now goes through `resolveEvaluatedMesh` (which reaches
  // the BoxData geometry through the `data` socket), so the real assertions below —
  // the ones this file was written for — are restored verbatim.
  //
  // Non-vacuous by construction: 'none'/0 was the FAILURE value, and every assertion
  // here (6 islands, 12 tris, per-island [0,0,1,1]) is unreachable from it. It is also
  // unreachable from the OLD synthetic cross-unfold, whose islands are sub-regions.
  test('default cube (split Object) → 6 real BoxGeometry islands through the object↔data reach (#378)', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return typeof w.__basher_uv_islands === 'function';
    });

    const uv = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_uv_islands!('n_box');
    });
    console.log(`[p06-3 uv box #378] ${JSON.stringify(uv)}`);

    // three.js BoxGeometry maps EVERY face to the FULL [0,1] square → 6 islands,
    // 12 triangles, each island bound [0,0,1,1]. The synthetic unfold could NOT
    // pass the per-island bounds check (its faces are distinct sub-regions).
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBe(6);
    expect(uv.triangleCount).toBe(12); // 6 faces × 2 tris
    expect(uv.sampled).toBe(false);
    const [minU, minV, maxU, maxV] = uv.bounds!;
    expect(minU).toBeCloseTo(0, 5);
    expect(minV).toBeCloseTo(0, 5);
    expect(maxU).toBeCloseTo(1, 5);
    expect(maxV).toBeCloseTo(1, 5);
  });

  // #462: the source is a SPLIT sphere (Object → SphereData). It used to be a fused
  // `SphereMesh`, whose `evaluate` has thrown since the sphere split (C1 Slice 4) — so
  // this asserted nothing and simply failed. The reach under test is unchanged and is
  // the POINT of the case: `__basher_uv_islands` is asked for the OBJECT, exactly as the
  // cube case above asks for `n_box`, and must resolve the geometry through `data`.
  //
  // Still non-vacuous against the cube case it sits beside: a UV sphere is ONE island
  // (the equirectangular wrap is connected), a BoxGeometry is SIX. Neither count is
  // reachable from the other, nor from the 'none'/0 failure value.
  test('split sphere (Object → SphereData) → exactly 1 connected real island', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return typeof w.__basher_uv_islands === 'function';
    });

    await page.evaluate(
      ({ ops }) => {
        const w = window as unknown as BasherWindow;
        const dag = w.__basher_dag.getState();
        dag.dispatchAtomic(ops as Op[], 'user', 'p06-3 split sphere');
      },
      {
        ops: splitSphereOps({
          objectId: 'n_uvsphere',
          radius: 0.5,
          widthSegments: 16,
          heightSegments: 12,
        }),
      },
    );

    const uv = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_uv_islands!('n_uvsphere');
    });
    console.log(`[p06-3 uv sphere] ${JSON.stringify(uv)}`);
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBe(1);
    expect(uv.triangleCount).toBeGreaterThan(0);
  });

  // #1053 — the import arrives native; its islands come from the stored mesh (the clone road
  // that read them off the loaded clone is retired).
  test('an imported mesh → real islands from its stored geometry (not null)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return (
        typeof w.__basher_uv_islands === 'function' &&
        typeof w.__basher_ingestGltfFolder === 'function'
      );
    });

    await page.evaluate(async (file) => {
      const w = window as unknown as BasherWindow;
      const bytes = new Uint8Array(await fetch(`/assets/${file}`).then((r) => r.arrayBuffer()));
      await w.__basher_ingestGltfFolder!([{ relativePath: file, bytes }], 'p06-3');
    }, FIXTURE);
    await expect.poll(async () => (await firstMaterialMesh(page))?.road).toBe('native');

    // The OBJECT — the selection id every seam keyed on "the mesh" answers to.
    const childId = (await firstMaterialMesh(page))?.objectId ?? null;
    expect(childId).not.toBeNull();

    // The mesh may need a tick to register; retry the seam until it resolves.
    const uv = await page.evaluate(async (id: string) => {
      const w = window as unknown as BasherWindow;
      for (let i = 0; i < 40; i++) {
        const r = w.__basher_uv_islands!(id);
        if (r.status === 'ok') return r;
        await new Promise((res) => setTimeout(res, 50));
      }
      return w.__basher_uv_islands!(id);
    }, childId!);
    console.log(`[p06-3 uv imported ${childId}] ${JSON.stringify(uv)}`);

    // Real stored geometry → at least one island with real triangles (NOT null,
    // NOT the synthetic placeholder the old UVEditor showed for glTF).
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBeGreaterThanOrEqual(1);
    expect(uv.triangleCount).toBeGreaterThan(0);
  });
});

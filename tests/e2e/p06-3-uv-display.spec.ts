// v0.6 #3 (#181, W1) — REAL UV display.
//
// THE FEATURE: the UVEditor shows the REAL UV layout of any mesh, extracted from
// the actual BufferGeometry (resolver for box/sphere; loaded clone for glTF), via
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

const ASSET_REF = 'assets/two-material-textured-quad.gltf';
const FIXTURE_URL = '/assets/two-material-textured-quad.gltf';

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
  __basher_importGltf?: (buffer: ArrayBuffer, assetRef: string) => Promise<{ gltfAssetId: string }>;
  __basher_writeOpfsBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  __basher_gltf_meshes?: () => { slot: number }[];
}

test.describe('v0.6 #3 W1 — real UV display', () => {
  test('default BoxMesh → 6 real islands, each spanning the full [0,1] UV square', async ({
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
    console.log(`[p06-3 uv box] ${JSON.stringify(uv)}`);

    // Side A = the REAL BoxGeometry uv attribute. Synthetic cross unfold could not
    // produce 6 islands each spanning [0,0,1,1].
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBe(6);
    expect(uv.triangleCount).toBe(12); // 6 faces × 2 tris
    expect(uv.sampled).toBe(false);
    expect(uv.bounds).not.toBeNull();
    const [minU, minV, maxU, maxV] = uv.bounds!;
    expect(minU).toBeCloseTo(0, 4);
    expect(minV).toBeCloseTo(0, 4);
    expect(maxU).toBeCloseTo(1, 4);
    expect(maxV).toBeCloseTo(1, 4);
  });

  test('SphereMesh → exactly 1 connected real island', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return typeof w.__basher_uv_islands === 'function';
    });

    await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const dag = w.__basher_dag.getState();
      dag.dispatchAtomic(
        [
          {
            type: 'addNode',
            nodeId: 'n_uvsphere',
            nodeType: 'SphereMesh',
            params: { radius: 0.5, widthSegments: 16, heightSegments: 12 },
          },
        ],
        'user',
        'p06-3 sphere',
      );
    });

    const uv = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_uv_islands!('n_uvsphere');
    });
    console.log(`[p06-3 uv sphere] ${JSON.stringify(uv)}`);
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBe(1);
    expect(uv.triangleCount).toBeGreaterThan(0);
  });

  test('glTF child → real islands from the loaded clone geometry (not null)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return (
        typeof w.__basher_uv_islands === 'function' &&
        typeof w.__basher_importGltf === 'function' &&
        typeof w.__basher_writeOpfsBytes === 'function'
      );
    });

    await page.evaluate(
      async ({ url, ref }) => {
        const w = window as unknown as BasherWindow;
        const buf = await fetch(url).then((r) => r.arrayBuffer());
        await w.__basher_writeOpfsBytes!(ref, new Uint8Array(buf));
        await w.__basher_importGltf!(buf, ref);
      },
      { url: FIXTURE_URL, ref: ASSET_REF },
    );
    // Wait until the clone is rendered (both slots present) so its geometry exists.
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      const s = w.__basher_gltf_meshes ? w.__basher_gltf_meshes() : [];
      return s.length >= 1;
    });

    // Find a GltfChild node id from the DAG.
    const childId = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      const nodes = w.__basher_dag.getState().state.nodes;
      return Object.keys(nodes).find((id) => nodes[id].type === 'GltfChild') ?? null;
    });
    expect(childId).not.toBeNull();

    // The clone may need a tick to register; retry the seam until it resolves.
    const uv = await page.evaluate(async (id: string) => {
      const w = window as unknown as BasherWindow;
      for (let i = 0; i < 40; i++) {
        const r = w.__basher_uv_islands!(id);
        if (r.status === 'ok') return r;
        await new Promise((res) => setTimeout(res, 50));
      }
      return w.__basher_uv_islands!(id);
    }, childId!);
    console.log(`[p06-3 uv gltf-child ${childId}] ${JSON.stringify(uv)}`);

    // Real loaded geometry → at least one island with real triangles (NOT null,
    // NOT the synthetic placeholder the old UVEditor showed for glTF).
    expect(uv.status).toBe('ok');
    expect(uv.islandCount).toBeGreaterThanOrEqual(1);
    expect(uv.triangleCount).toBeGreaterThan(0);
  });
});

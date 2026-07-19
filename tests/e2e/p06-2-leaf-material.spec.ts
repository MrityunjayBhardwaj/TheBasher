// v0.6 #2 (#178) W2 — the default cube (a split Object → BoxData after #365) renders
// through the ONE shared PrimitiveMaterial builder as a MeshPhysicalMaterial, with NO
// colour regression after the Standard→Physical switch. The mesh read is keyed by the
// Object scene child `n_box`; the material lives on its linked BoxData.
//
// H40 discipline: side-A is the REAL three.js mesh.material read via the
// __basher_mesh_material seam (NOT the resolver). Falsifiable — if openpbrToThree
// stops setting roughness explicitly, three's default (1) makes the 0.3 assertion
// RED; if the Physical switch is reverted, the `type` assertion goes RED.

import { expect, test } from './_fixtures';

interface MeshMaterial {
  type: string | null;
  color: string | null;
  roughness: number | null;
  metalness: number | null;
  opacity: number | null;
  hasMap: boolean;
  clearcoat: number | null;
  transmission: number | null;
}
interface BasherWindow {
  __basher_mesh_material?: (nodeId: string) => MeshMaterial | null;
}

test.describe('v0.6 #2 W2 — primitive renders one MeshPhysicalMaterial leaf', () => {
  test('default box: MeshPhysicalMaterial, OpenPBR fresh look, colour unchanged', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as BasherWindow;
      return (
        typeof w.__basher_mesh_material === 'function' && w.__basher_mesh_material('n_box') != null
      );
    });

    const mat = await page.evaluate(() => {
      const w = window as unknown as BasherWindow;
      return w.__basher_mesh_material!('n_box');
    });
    console.log(`[p06-2 leaf] ${JSON.stringify(mat)}`);

    // Side-A = the REAL three.js material object (not the resolver).
    expect(mat).not.toBeNull();
    expect(mat!.type).toBe('MeshPhysicalMaterial'); // Standard→Physical switch (W2)
    expect(mat!.color?.toLowerCase()).toBe('#5af07a'); // default box colour PRESERVED
    expect(mat!.roughness).toBeCloseTo(0.3, 5); // OpenPBR fresh default (D-03), set EXPLICITLY
    expect(mat!.metalness).toBeCloseTo(0, 5);
    expect(mat!.opacity).toBeCloseTo(1, 5);
    expect(mat!.hasMap).toBe(false); // no texture map on a fresh primitive

    // 2.3 (perf, no-regression) — the DETERMINISTIC define-gating precondition,
    // not a flaky timing race (avoids the H71 perf-flake class). At coat=0 /
    // transmission=0 three compiles NO clearcoat/transmission GLSL
    // (WebGLPrograms.js:130,134 gate HAS_CLEARCOAT/HAS_TRANSMISSION on `> 0`;
    // MeshPhysicalMaterial.js:104,176 setters only recompile across the boundary),
    // so this Physical material ≈ Standard cost. Source-grounded in W2 task 2.0.
    expect(mat!.clearcoat).toBeCloseTo(0, 5);
    expect(mat!.transmission).toBeCloseTo(0, 5);
  });
});

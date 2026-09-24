// #1197 — a skinned mesh draws natively in the live app: a three SkinnedMesh over the stored mesh,
// deformed by the Armature modifier's rule, with no asset clone anywhere.
//
// WHICH ROAD THIS TAKES, SAID FIRST. The product still refuses a skinned file on the native road
// (#1205 — a native character cannot yet take a motion or have its bones posed), so no product
// seam can bring one across yet. This spec builds the native ops through the test-only door
// (`__buildSkinnedNativeGltfImportOpsForTests`, loaded as a dev-server module) and dispatches them
// into the live editor. It witnesses the DRAW. The product-road gate — the same tip-vertex check
// through `__basher_ingestGltfFolder`, and surviving the source's deletion — lands with #1205, which
// lifts the refusal.
//
// The oracle: Blender 5.1.1 on the same file (`ref/probes/blender-armature-deform/
// q13_skinned_bar_oracle.py`), tip vertex at frames 12 and 24 (24 fps).
import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';

interface SkinSeam {
  boneCount: number;
  bound: boolean;
  count: number;
  rest: (i: number) => [number, number, number];
  vertex: (i: number) => [number, number, number];
}
interface BasherWindow {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { type: string }>;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => SkinSeam | null;
}

/** Blender's tip, glTF space: frame 0 (rest), 12 (0.5 s), 24 (1 s). */
const BLENDER_TIP: Record<number, [number, number, number]> = {
  0: [0.2, 2, 0],
  0.5: [-0.528135, 1.872395, 0],
  1: [-0.978764, 1.286395, 0],
};

async function setTime(page: Page, seconds: number): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as BasherWindow).__basher_time.getState().setTime(s),
    seconds,
  );
  // Two frames: the skinned draw poses its bones in a useFrame, then three reads them.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

test('#1197 — skinned-bar draws natively, deformed as Blender deforms it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const w = window as unknown as BasherWindow;
    return Boolean(w.__basher_dag?.getState().state.outputs.scene && w.__basher_time);
  });

  const types = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.__buildSkinnedNativeGltfImportOpsForTests({
      buffer,
      assetRef: 'user-imports/p1197/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    return Object.values(w.__basher_dag.getState().state.nodes).map((n) => n.type);
  });
  // Native: a skeleton, its clip, a deform on the mesh's stack — and nothing of the clone road.
  expect(types).toEqual(
    expect.arrayContaining(['Skeleton', 'AnimationClip', 'ArmatureModifier', 'PolyMeshData']),
  );
  expect(types.filter((t) => t.startsWith('Gltf'))).toEqual([]);

  await page.waitForFunction(
    () => Boolean((window as unknown as BasherWindow).__basher_gltf_skin?.()),
    {
      timeout: 15_000,
    },
  );
  // Blender's tip is the vertex resting at (0.2, 2, 0) in the file; the import Group places the
  // model by its pivot, so the drawn rest is that point plus the Group's offset.
  const seam = await page.evaluate(() => {
    const s = (window as unknown as BasherWindow).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return { boneCount: s.boneCount, bound: s.bound, tip, rest: s.rest(tip) };
  });
  // Two vertex groups, plus the one bone that never moves.
  expect(seam.bound).toBe(true);
  expect(seam.boneCount).toBe(3);
  const offset = seam.rest.map((c, k) => c - BLENDER_TIP[0][k]);

  for (const t of [0, 0.5, 1]) {
    await setTime(page, t);
    const drawn = await page.evaluate(
      (i) => (window as unknown as BasherWindow).__basher_gltf_skin!()!.vertex(i),
      seam.tip,
    );
    drawn.forEach((c, k) =>
      expect(c - offset[k], `tip at ${t}s, axis ${k}`).toBeCloseTo(BLENDER_TIP[t][k], 3),
    );
  }
  expect(errors).toEqual([]);
});

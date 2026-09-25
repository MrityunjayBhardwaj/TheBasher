// #1197 — a skinned mesh draws natively in the live app: a three SkinnedMesh over the stored mesh,
// deformed by the Armature modifier's rule, with no asset clone anywhere.
//
// WHICH ROAD THIS TAKES, SAID FIRST. The product still refuses a skinned file on the native road
// (#1205 — a native character cannot yet have its bones posed), so no product
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
  __basher_armature?: { names: string[]; matrices: number[][] };
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
  // Native: a skeleton, the base pose layer holding its keys (#1211), a deform on the mesh's stack
  // — and nothing of the clone road.
  expect(types).toEqual(
    expect.arrayContaining(['Skeleton', 'PoseLayer', 'ArmatureModifier', 'PolyMeshData']),
  );
  expect(types).not.toContain('AnimationClip');
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

  // #1206 — the bone chrome over the mesh bends with it. Bone1 is a LEAF; Blender draws it along
  // its own posed +Y, so at 0.5 s (frame 12) its drawn axis is Blender's tail − head, (−0.6756, 0,
  // 0.7373) in Z-up = (−0.6756, 0.7373, 0) in glTF (ref/probes/blender-native-character/
  // q1206_leaf_tail.py). Before #1206 it continued its parent and stayed at (0, 1, 0).
  await setTime(page, 0.5);
  const leafAxis = await page.evaluate(() => {
    const a = (window as unknown as BasherWindow).__basher_armature!;
    const m = a.matrices[a.names.indexOf('Bone1')];
    const len = Math.hypot(m[4], m[5], m[6]);
    return [m[4] / len, m[5] / len, m[6] / len];
  });
  [-0.6756, 0.7373, 0].forEach((c, k) =>
    expect(leafAxis[k], `drawn leaf axis at 0.5s, axis ${k}`).toBeCloseTo(c, 3),
  );

  // #1207 — key the mesh Object's position. The overlay now copies its value every frame; the
  // draw must be built once and still pose by the action, and a registry sweep (which evicts the
  // shared geometry the draw only clones) must not rebuild it either.
  await page.evaluate(() => {
    const w = window as unknown as BasherWindow;
    const dag = w.__basher_dag.getState();
    const nodes = dag.state.nodes as Record<
      string,
      { type: string; inputs?: Record<string, unknown> }
    >;
    const [meshId] = Object.entries(nodes).find(
      ([, n]) =>
        n.type === 'Object' &&
        nodes[(n.inputs?.data as { node?: string } | undefined)?.node ?? '']?.type ===
          'ArmatureModifier',
    )!;
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'p1207_key',
          nodeType: 'KeyframeChannelVec3',
          params: {
            name: 'position',
            target: meshId,
            paramPath: 'position',
            keyframes: [
              { time: 0, value: [0, 0, 0], easing: 'linear' },
              { time: 1, value: [1, 0, 0], easing: 'linear' },
            ],
          },
        },
      ],
      'user',
      'key the skinned Object',
    );
  });
  await setTime(page, 0);
  const held = await page.evaluate(async () => {
    const w = window as unknown as BasherWindow;
    const sweep = await import('/src/viewport/geometrySweep.ts');
    const first = w.__basher_gltf_skin!();
    const before = sweep.sweepStats().sweeps;
    let frames = 0;
    let rebuilt = 0;
    // Step time until a sweep has run, and a little past it.
    while (frames < 240 && (sweep.sweepStats().sweeps === before || frames < 40)) {
      w.__basher_time.getState().setTime((frames % 20) * 0.05);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (w.__basher_gltf_skin!() !== first) rebuilt++;
      frames++;
    }
    return { frames, rebuilt, sweeps: sweep.sweepStats().sweeps - before };
  });
  expect(held.sweeps, 'a sweep ran while the keyed Object was drawn').toBeGreaterThan(0);
  expect(held.rebuilt, `frames on a different build, of ${held.frames}`).toBe(0);
  // Still posed by the action, now also moved by its key: +1 on x at 1 s.
  await setTime(page, 1);
  const keyedTip = await page.evaluate(
    (i) => (window as unknown as BasherWindow).__basher_gltf_skin!()!.vertex(i),
    seam.tip,
  );
  const keyedOffset = [offset[0] + 1, offset[1], offset[2]];
  keyedTip.forEach((c, k) =>
    expect(c - keyedOffset[k], `keyed tip at 1s, axis ${k}`).toBeCloseTo(BLENDER_TIP[1][k], 3),
  );
  expect(errors).toEqual([]);
});

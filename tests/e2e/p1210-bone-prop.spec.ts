// #1210 — an Object parented to a bone is DRAWN where Blender stands it, and moves with the bone.
// The resolver side is proven in `src/app/boneParent.test.ts`; this is the renderer's side of the
// same product (`ObjectR` → `BoneParentR`), read off the real three object, paired with the
// resolver at the same instant.
//
// Through the test door, as #1218's spec, until #1205 lifts the skin refusal. Oracle: Blender 5.1.1
// (ref/probes/blender-native-character/q1210_bone_prop_oracle.py), glTF space, 24 fps.
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<string, { meta?: { name?: string } }>;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
  __basher_mesh_world_quaternion: (id: string) => [number, number, number, number] | null;
  __basher_world_transform: (
    id: string,
    ctx: { time: { frame: number; seconds: number; normalized: number } },
  ) => {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  } | null;
}

const BLENDER = [
  { seconds: 0, origin: [1.8, 2.35, -0.2] },
  { seconds: 0.5, origin: [0.97803, 2.26368, -0.2] },
  { seconds: 1, origin: [0.43033, 1.64473, -0.2] },
];

test('#1210 — a prop parented to a keyed bone is drawn where Blender stands it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const propId = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar-bone-prop.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.__buildSkinnedNativeGltfImportOpsForTests({
      buffer,
      assetRef: 'user-imports/p1210/skinned-bar-bone-prop.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    return Object.keys(nodes).find((id) => nodes[id].meta?.name === 'Prop')!;
  });
  expect(propId).toBeTruthy();
  await page.waitForFunction(
    (id) => Boolean((window as unknown as W).__basher_mesh_world_position?.(id)),
    propId,
  );

  for (const { seconds, origin } of BLENDER) {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const { drawn, drawnQ, resolved } = await page.evaluate(
      ({ id, s }) => {
        const w = window as unknown as W;
        return {
          drawn: w.__basher_mesh_world_position(id)!,
          drawnQ: w.__basher_mesh_world_quaternion(id)!,
          resolved: w.__basher_world_transform(id, {
            time: { frame: s * 24, seconds: s, normalized: 0 },
          })!,
        };
      },
      { id: propId, s: seconds },
    );
    drawn.forEach((c, k) => {
      expect(c, `drawn at ${seconds} s, axis ${k}`).toBeCloseTo(origin[k], 3);
      expect(c, `drawn == resolved at ${seconds} s, axis ${k}`).toBeCloseTo(
        resolved.position[k],
        5,
      );
    });
    // The turn too: the prop's own 30° under the bone's swing. q and -q are one rotation.
    const dot = drawnQ.reduce((sum, c, k) => sum + c * resolved.quaternion[k], 0);
    expect(Math.abs(dot), `drawn turn == resolved turn at ${seconds} s`).toBeCloseTo(1, 5);
  }
});

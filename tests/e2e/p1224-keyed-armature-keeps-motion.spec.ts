// #1224 — keying the armature Object, and the skinned mesh's Object, leaves the motion playing in
// the running editor.
//
// The armature Object carries the pose wire (`ObjectValue.pose`), a closure. The render overlay on a
// keyed Object once copied its value JSON-style, which drops functions, so a key on the armature
// would have stopped the prop on its bone, and a key on the mesh would have stopped the skin
// (#1236). Each key here holds the Object's own position, so the prop must still be drawn where
// Blender stands it (the #1210 oracle), and the skin must still move — without being rebuilt every
// frame (#1207 measured one rebuild per frame once the mesh's Object was keyed).
//
// Oracle: Blender 5.1.1 (ref/probes/blender-native-character/q1210_bone_prop_oracle.py), glTF space,
// 24 fps. Through the test door, as #1210's spec, until #1205 lifts the skin refusal.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  meta?: { name?: string };
  params: Record<string, unknown>;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_mesh_world_position: (id: string) => [number, number, number] | null;
  __basher_world_transform: (
    id: string,
    ctx: { time: { frame: number; seconds: number; normalized: number } },
  ) => { position: [number, number, number] } | null;
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

const BLENDER = [
  { seconds: 0, origin: [1.8, 2.35, -0.2] },
  { seconds: 0.5, origin: [0.97803, 2.26368, -0.2] },
  { seconds: 1, origin: [0.43033, 1.64473, -0.2] },
];

const twoFrames = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

test('#1224 — a keyed armature and a keyed skinned mesh keep their motion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const ids = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const buffer = await fetch('/assets/skinned-bar-bone-prop.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.__buildSkinnedNativeGltfImportOpsForTests({
      buffer,
      assetRef: 'user-imports/p1224/skinned-bar-bone-prop.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const entries = Object.entries(nodes);
    const prop = entries.find(([, n]) => n.meta?.name === 'Prop')![0];
    const modifier = entries.find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes[modifier].inputs.armature as { node: string }).node;
    const mesh = entries.find(
      ([, n]) => n.type === 'Object' && (n.inputs.data as { node?: string })?.node === modifier,
    )![0];
    // Key both Objects where they stand, as the product keys an Object: a direct channel.
    const keyInPlace = (target: string) => {
      const position = nodes[target].params.position as number[];
      return {
        type: 'addNode',
        nodeId: `${target}_p1224_position`,
        nodeType: 'KeyframeChannelVec3',
        params: {
          name: 'position',
          target,
          paramPath: 'position',
          keyframes: [
            { time: 0, value: position, easing: 'linear' },
            { time: 1, value: position, easing: 'linear' },
          ],
        },
      };
    };
    dag.dispatchAtomic([keyInPlace(armature), keyInPlace(mesh)], 'user', 'key in place');
    return { prop, armature, mesh };
  });
  // Under the JSON-style overlay the prop on a keyed armature was not drawn at all, so this is a
  // check with a message, not a bare wait.
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => Boolean((window as unknown as W).__basher_mesh_world_position?.(id)),
          ids.prop,
        ),
      { message: 'the prop on a bone of the keyed armature is drawn', timeout: 10_000 },
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the keyed skinned mesh is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);

  // The prop on a bone of the KEYED armature: drawn where Blender stands it, and equal to the
  // resolver at the same instant.
  for (const { seconds, origin } of BLENDER) {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await page.evaluate(twoFrames);
    const { drawn, resolved } = await page.evaluate(
      ({ id, s }) => {
        const w = window as unknown as W;
        return {
          drawn: w.__basher_mesh_world_position(id)!,
          resolved: w.__basher_world_transform(id, {
            time: { frame: s * 24, seconds: s, normalized: 0 },
          })!,
        };
      },
      { id: ids.prop, s: seconds },
    );
    drawn.forEach((c, k) => {
      expect(c, `drawn at ${seconds} s, axis ${k}`).toBeCloseTo(origin[k], 3);
      expect(c, `drawn == resolved at ${seconds} s, axis ${k}`).toBeCloseTo(
        resolved.position[k],
        5,
      );
    });
  }

  // The skin of the KEYED mesh Object: the top vertex leaves its rest and moves between frames,
  // and the draw is the same build across frames — not rebuilt per frame.
  const skin = await page.evaluate(async (frames) => {
    const w = window as unknown as W;
    const s = w.__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) if (s.rest(i)[1] > s.rest(tip)[1] + 1e-6) tip = i;
    const time = w.__basher_time.getState();
    time.setTime(0);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const first = w.__basher_gltf_skin!();
    const at0 = first!.vertex(tip);
    let rebuilt = 0;
    for (let f = 1; f <= frames; f++) {
      time.setTime(f / frames);
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (w.__basher_gltf_skin!() !== first) rebuilt++;
    }
    return { rest: s.rest(tip), at0, at1: w.__basher_gltf_skin!()!.vertex(tip), rebuilt };
  }, 10);
  const moved = Math.hypot(...skin.at1.map((c, k) => c - skin.at0[k]));
  expect(moved, 'the keyed mesh’s tip moves between 0 s and 1 s').toBeGreaterThan(0.1);
  expect(skin.rebuilt, 'skinned draw rebuilt per frame under a key').toBe(0);
});

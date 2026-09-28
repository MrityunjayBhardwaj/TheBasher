// #1215 — Auto-Key on a native character's bone, from the inspector's pose row, in the running editor.
//
// Blender 5.1.1's pose-bone Rotation field auto-keys only a property that already has an F-curve
// (`interface_anim.cc:318-321` → `autokeyframe_property(..., only_if_property_keyed)`); the key
// button beside it is I over the field. So: pose Bone1, key it at 0 s with the key button (0°), turn
// Auto-Key on, and type 90 at 1 s — that edit is a KEY in the hand-pose layer, not a static value the
// curve would outrank. The drawn tip then turns 0° → 90° over the second: at rest at 0 s, turned at
// 1 s, halfway (45°) at 0.5 s, where the field shows 45. One undo takes the 1 s key back.
//
// Oracle, arithmetic: Bone1's head is (0, 1, 0), its tip rests at (0.2, 2, 0); turned θ about Z the
// tip is (0.2·cosθ − sinθ, 1 + 0.2·sinθ + cosθ, 0). Through the product's native reader, dispatched directly, as p1244.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
      undo: () => unknown;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

const tipAt = (deg: number): [number, number, number] => {
  const r = (deg * Math.PI) / 180;
  return [0.2 * Math.cos(r) - Math.sin(r), 1 + 0.2 * Math.sin(r) + Math.cos(r), 0];
};

test('#1215 — with Auto-Key on, editing a keyed bone rotation keys it at the playhead; the skin plays the keys', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const armature = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1215e/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    // What a click on the armature's bone does: select the Object, then the bone.
    selection.useSelectionStore.getState().select(id);
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
    return id;
  });

  const setTime = async (s: number) => {
    await page.evaluate((t) => (window as unknown as W).__basher_time.getState().setTime(t), s);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  };
  await setTime(0);
  await expect(page.getByTestId('inspector-selected-bone-name')).toHaveValue('Bone1');
  await page.getByTestId('inspector-bone-pose-add').click();
  const z = page.getByTestId('inspector-bone-pose-rotation-z');
  await expect(z).toHaveValue('0');

  // Key it at 0 s: the key button marks the rotation keyed.
  const key = page.getByTestId('inspector-bone-pose-key');
  await key.click();
  await expect(key).toHaveAttribute('data-keyed', 'true');

  // Auto-Key on, and an edit at 1 s.
  await page.evaluate(async () => {
    const autoKey = await import('/src/app/stores/autoKeyStore.ts');
    autoKey.useAutoKeyStore.setState({ enabled: true });
  });
  await setTime(1);
  await z.fill('90');

  const keys = () =>
    page.evaluate((id) => {
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes as Record<
        string,
        { type: string; params: Record<string, unknown>; inputs: Record<string, unknown> }
      >;
      const layer = (nodes[id].inputs.pose as { node: string }).node;
      const curve = (
        nodes[layer].params.channels as {
          bone: string;
          component: string;
          keyframes: { time: number; value: number[] }[];
        }[]
      ).find((c) => c.bone === 'Bone1' && c.component === 'rotation');
      return curve?.keyframes.map((k) => [k.time, k.value[2]]) ?? [];
    }, armature);
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);
  const seam = await page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let tip = 0;
    for (let i = 1; i < s.count; i++) {
      const r = s.rest(i);
      const best = s.rest(tip);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) tip = i;
    }
    return { tip, rest: s.rest(tip) };
  });
  const offset = seam.rest.map((c, k) => c - [0.2, 2, 0][k]);
  const drawnTip = async (s: number) => {
    await setTime(s);
    const v = await page.evaluate(
      (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
      seam.tip,
    );
    return v.map((c, k) => c - offset[k]);
  };
  for (const [t, deg] of [
    [0, 0],
    [0.5, 45],
    [1, 90],
  ] as const) {
    const drawn = await drawnTip(t);
    drawn.forEach((c, k) =>
      expect(c, `drawn tip at ${t}s (${deg}°), axis ${k}`).toBeCloseTo(tipAt(deg)[k], 3),
    );
  }
  // Where the edit went: a key at 1 s in the hand-pose layer's curve.
  await expect.poll(keys, { message: 'the edit keyed at 1 s' }).toEqual([
    [0, 0],
    [1, 90],
  ]);

  // The field shows the rotation as played: 45 at 0.5 s.
  await setTime(0.5);
  await expect(z).toHaveValue('45');

  // One undo: the 1 s key is gone and the tip at 1 s is back at rest.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await keys()).toEqual([[0, 0]]);
  const back = await drawnTip(1);
  back.forEach((c, k) => expect(c, `restored at 1s, axis ${k}`).toBeCloseTo(tipAt(0)[k], 3));
});

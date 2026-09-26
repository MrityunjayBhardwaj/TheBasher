// #1201 — a director renames a bone of a native character from the inspector's bone name field, and
// the drawn skin does not move: the vertex group and the keys follow the name, as Blender's rename
// leaves the deform unchanged (measured 0.0 at frames 0/12/24, `q1201_bone_rename_oracle.py`). One undo
// puts the old name back.
//
// Subject: skinned-bar.glb through the product's native reader (`buildNativeGltfImportOps`), dispatched directly; the product road itself is p1205's.
// The bar's clip keys Bone1 across the whole clip, so at 0.5 s the drawn skin is bent; a rename that
// lost the group or the keys would draw it at rest.
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  params: Record<string, unknown>;
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

test('#1201 — renaming a bone in the inspector leaves the drawn skin where it was', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1201/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    selection.useSelectionStore.getState().select(id);
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
  });

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())), {
      message: 'the bar is drawn skinned',
      timeout: 10_000,
    })
    .toBe(true);

  const drawnAt = async (seconds: number) => {
    await page.evaluate(
      (s) => (window as unknown as W).__basher_time.getState().setTime(s),
      seconds,
    );
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    return page.evaluate(() => {
      const s = (window as unknown as W).__basher_gltf_skin!()!;
      return Array.from({ length: s.count }, (_, i) => ({ rest: s.rest(i), drawn: s.vertex(i) }));
    });
  };
  const namesInGraph = () =>
    page.evaluate(() => {
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
      const skeleton = Object.values(nodes).find((n) => n.type === 'Skeleton')!;
      const mesh = Object.values(nodes).find((n) => n.type === 'PolyMeshData')!;
      return {
        bones: (skeleton.params.bones as { name: string }[]).map((b) => b.name),
        groups: (mesh.params.mesh as { vertexGroups: string[] }).vertexGroups,
      };
    });

  const before = await drawnAt(0.5);
  // Control: the bar is bent at 0.5 s, so a skin fallen to rest would show below.
  const bent = Math.max(
    ...before.map((v) => Math.max(...v.drawn.map((c, k) => Math.abs(c - v.rest[k])))),
  );
  expect(bent, 'the bar is bent at 0.5 s').toBeGreaterThan(0.1);

  const field = page.getByTestId('inspector-selected-bone-name');
  await expect(field).toHaveValue('Bone1');
  await field.fill('Arm.L');
  await field.press('Enter');
  await expect(field).toHaveValue('Arm.L');
  expect(await namesInGraph()).toEqual({ bones: ['Bone0', 'Arm.L'], groups: ['Bone0', 'Arm.L'] });

  const after = await drawnAt(0.5);
  expect(after.length).toBe(before.length);
  after.forEach((v, i) =>
    v.drawn.forEach((c, k) =>
      expect(c, `vertex ${i} axis ${k} after the rename`).toBeCloseTo(before[i].drawn[k], 4),
    ),
  );

  // Taking another bone's name: Blender's `.001`.
  await field.fill('Bone0');
  await field.press('Enter');
  await expect(field).toHaveValue('Bone0.001');

  // One undo per rename puts each name back.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect((await namesInGraph()).bones).toEqual(['Bone0', 'Arm.L']);
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await namesInGraph()).toEqual({ bones: ['Bone0', 'Bone1'], groups: ['Bone0', 'Bone1'] });
});

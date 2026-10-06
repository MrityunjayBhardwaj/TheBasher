// #1338 — a bone's position and scale pose from the inspector, the drawn skin follows, and the
// agent's verb writes the same layer.
//
// The skinned bar: Bone1's head is at (0, 1, 0) and the bar's top vertices rest 1 above it, at
// (0.2, 2, 0) for the tip (`p1244`). At 0 s the clip holds Bone1 at its rest rotation, and its rest
// frame is aligned with the world (measured in p1335: the drawn rest bone points along +Y). A
// member REPLACES the bone's local transform, whose rest position is (0, 1, 0) from Bone0, so
// typing position x = 0.5 makes it (0.5, 1, 0): y and z come from rest. With scale (1, 2, 1) the
// tip lands at (0.5, 1, 0) + (0.2, 2·1, 0) = (0.7, 3, 0). The oracle is that arithmetic, not a
// reading of the app.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';

interface Node {
  type: string;
  inputs: Record<string, unknown>;
  params: Record<string, unknown>;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { outputs: { scene?: { node: string } }; nodes: Record<string, Node> };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
}

async function importBar(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  return page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1338/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const id = (nodes[modifier].inputs.armature as { node: string }).node;
    selection.useSelectionStore.getState().select(id);
    modes.useArmatureModeStore.getState().setMode(id, 'pose');
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
    w.__basher_time.getState().setTime(0);
    return id;
  });
}

const layerOf = (page: Page, armature: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const feed = (nodes[id].inputs.pose as { node: string }).node;
    return JSON.stringify(nodes[feed].params.members);
  }, armature);

test('#1338 — position and scale pose from the panel, the skin follows, and the agent agrees', async ({
  page,
}) => {
  const armature = await importBar(page);
  await page.getByTestId('inspector-bone-pose-add').click();
  await expect(page.getByTestId('inspector-bone-pose-scale-y')).toBeVisible();
  // Not posed yet: the fields are empty and show the rest value.
  await expect(page.getByTestId('inspector-bone-pose-scale-y')).toHaveValue('');
  await expect(page.getByTestId('inspector-bone-pose-scale-y')).toHaveAttribute('placeholder', '1');
  await expect(page.getByTestId('inspector-bone-pose-key-scale')).toBeDisabled();

  await page.getByTestId('inspector-bone-pose-scale-y').fill('2');
  await page.getByTestId('inspector-bone-pose-position-x').fill('0.5');
  await expect(page.getByTestId('inspector-bone-pose-scale-y')).toHaveValue('2');
  await expect(page.getByTestId('inspector-bone-pose-scale-x')).toHaveValue('1');
  await expect(page.getByTestId('inspector-bone-pose-position-x')).toHaveValue('0.5');
  await expect(page.getByTestId('inspector-bone-pose-position-y')).toHaveValue('1');
  await expect(page.getByTestId('inspector-bone-pose-key-scale')).toBeEnabled();

  // The render: the bar's tip lands where the arithmetic says.
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
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
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const drawn = await page.evaluate(
    (i) => (window as unknown as W).__basher_gltf_skin!()!.vertex(i),
    seam.tip,
  );
  drawn.forEach((c, k) =>
    expect(c - offset[k], `drawn tip axis ${k}`).toBeCloseTo([0.7, 3, 0][k], 3),
  );

  // The agent: the same pose through its verb, on the same rig, writes the same layer.
  const fromPanel = await layerOf(page, armature);
  const fromAgent = await page.evaluate(async (id) => {
    const w = window as unknown as W;
    const nodes = w.__basher_dag.getState().state.nodes;
    const feed = (nodes[id].inputs.pose as { node: string }).node;
    // Back to the member as "pose this bone" left it, then the agent's two poses.
    w.__basher_dag.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: feed,
          paramPath: 'members',
          value: [{ bone: 'Bone1', rotationMode: 'ZYX', rotation: [0, 0, 0] }],
        },
      ],
      'user',
      'reset',
    );
    const m = await import('/src/app/animate/dispatchMutator.ts');
    const a = m.dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: id, bone: 'Bone1', scale: [1, 2, 1] },
      'agent scale',
    );
    const b = m.dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: id, bone: 'Bone1', position: [0.5, 1, 0] },
      'agent position',
    );
    if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
    return JSON.stringify(w.__basher_dag.getState().state.nodes[feed].params.members);
  }, armature);
  expect(fromAgent).toBe(fromPanel);
});

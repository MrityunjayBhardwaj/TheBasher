// #1510 — Add › IK in Pose mode: Shift+I on a tip joint sets up the chain, its goal and pole, and the
// skin does not move; moving the goal then moves the tip to it.
//
// The skinned bar imported native: Bone0 → Bone1, its clip turning Bone1. A tip joint is extruded from
// Bone1 (the bar's end), so Bone0 → Bone1 → tip is a two-bone chain, bent wherever the clip has turned
// Bone1. At such a time, in Pose mode with the tip selected:
//   - Shift+I adds an ik layer on top of the chain, a goal bone on the drawn tip and a pole bone; the
//     drawn skin stays within 1e-5 of before, and the goal bone is selected;
//   - posing the goal from the inspector moves the drawn tip onto it, and the bar with it;
//   - on Bone1 (its parent is a root) the inspector's add IK says why it cannot.

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
    vertex: (i: number) => [number, number, number];
  } | null;
  __basher_armature?: { names: string[]; matrices: number[][] };
  __basher_three: {
    getState: () => {
      camera: { position: { set: (x: number, y: number, z: number) => void } };
      controlsTarget: { set: (x: number, y: number, z: number) => void } | null;
    };
  };
}

const T = 0.5;

async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

async function skin(page: Page): Promise<number[][]> {
  await settle(page);
  return page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    return Array.from({ length: s.count }, (_, i) => s.vertex(i));
  });
}

async function headOf(page: Page, bone: string): Promise<number[]> {
  await settle(page);
  return page.evaluate((name) => {
    const a = (window as unknown as W).__basher_armature!;
    const m = a.matrices[a.names.indexOf(name)];
    return [m[12], m[13], m[14]];
  }, bone);
}

const maxDelta = (a: number[][], b: number[][]) =>
  Math.max(...a.flatMap((v, i) => v.map((c, k) => Math.abs(c - b[i][k]))));

const selectedBone = (page: Page) =>
  page.evaluate(async () => {
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    return bones.useBoneSelectionStore.getState().boneName;
  });

test('#1510 — Shift+I adds an IK that leaves the skin still, and its goal then moves the tip', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const { armature, tip } = await page.evaluate(async (t) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const { dispatchMutatorFromUI } = await import('/src/app/animate/dispatchMutator.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1510/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = () => w.__basher_dag.getState().state.nodes;
    const mod = Object.entries(nodes()).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes()[mod].inputs.armature as { node: string }).node;
    const res = dispatchMutatorFromUI(
      'mutator.rig.editSkeleton',
      { object: armature, edit: { op: 'extrude', from: 'Bone1', name: 'Bone1_tip' } },
      'extrude',
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    const skeleton = (nodes()[armature].inputs.data as { node: string }).node;
    const names = (nodes()[skeleton].params.bones as { name: string }[]).map((b) => b.name);
    const tip = names.find((b) => b.startsWith('Bone1_tip'))!;
    selection.useSelectionStore.getState().select(armature);
    modes.useArmatureModeStore.getState().setMode(armature, 'pose');
    bones.useBoneSelectionStore.getState().selectBone(armature, tip, ['Bone0', 'Bone1', tip]);
    w.__basher_time.getState().setTime(t);
    return { armature, tip };
  }, T);
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0.5, 1.2, 0);
    t.camera.position.set(0.5, 1.2, 5);
  });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
    .toBe(true);

  // The chain is bent at the playhead (the clip has turned Bone1): Add › IK has a side to bend to.
  const [a, b, c] = [
    await headOf(page, 'Bone0'),
    await headOf(page, 'Bone1'),
    await headOf(page, tip),
  ];
  const u = b.map((x, k) => x - a[k]);
  const v = c.map((x, k) => x - b[k]);
  const cross = Math.hypot(
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  );
  expect(cross, 'the chain is bent at the playhead').toBeGreaterThan(1e-3);

  const before = await skin(page);
  await page.screenshot({ path: test.info().outputPath('1-before-add-ik.png') });
  await page
    .locator('body')
    .click({ position: { x: 5, y: 5 } })
    .catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+I');

  const layerId = `${armature}_ik_${tip}`;
  await expect
    .poll(() =>
      page.evaluate(
        ([id, arm]) => {
          const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
          const feed = nodes[arm].inputs.pose as { node: string } | undefined;
          return feed?.node === id ? JSON.stringify(nodes[id].params.ik) : null;
        },
        [layerId, armature] as const,
      ),
    )
    .toContain(`"goal":"${tip}_ik_goal"`);
  const added = await skin(page);
  await page.screenshot({ path: test.info().outputPath('2-after-add-ik.png') });
  expect(maxDelta(added, before), 'adding the IK does not move the skin').toBeLessThan(1e-5);
  const goal = `${tip}_ik_goal`;
  expect(await selectedBone(page)).toBe(goal);
  const goalAt = await headOf(page, goal);
  expect(
    Math.max(...goalAt.map((x, k) => Math.abs(x - c[k]))),
    'the goal is on the tip',
  ).toBeLessThan(1e-5);

  // Move the goal from the inspector: the tip follows it, and the bar with it.
  const to = [goalAt[0] - 0.4, goalAt[1] - 0.3, goalAt[2] + 0.2];
  await page.getByTestId('inspector-bone-pose-add').click();
  for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
    await page.getByTestId(`inspector-bone-pose-position-${axis}`).fill(String(to[i]));
  }
  await expect
    .poll(async () => {
      const at = await headOf(page, tip);
      return Math.max(...at.map((x, k) => Math.abs(x - to[k])));
    })
    .toBeLessThan(1e-3);
  const moved = await skin(page);
  await page.screenshot({ path: test.info().outputPath('3-goal-moved.png') });
  expect(maxDelta(moved, before), 'the bar followed the goal').toBeGreaterThan(0.05);

  // Refused by name from the inspector: Bone1's parent is a root, so there is no chain of two.
  await page.evaluate(async (arm) => {
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    bones.useBoneSelectionStore.getState().selectBone(arm, 'Bone1', ['Bone0', 'Bone1']);
  }, armature);
  await page.getByTestId('inspector-bone-add-ik').click();
  await expect(page.getByTestId('inspector-bone-add-ik-refusal')).toContainText(
    '"Bone0", the parent of "Bone1", has no parent',
  );

  // #1542 — the tip's inspector names its IK; with the goal deleted, it says why nothing solves.
  await page.evaluate(
    async ([arm, t]) => {
      const bones = await import('/src/app/stores/boneSelectionStore.ts');
      bones.useBoneSelectionStore.getState().selectBone(arm, t, ['Bone0', 'Bone1', t]);
    },
    [armature, tip] as const,
  );
  // The refusal said for Bone1 is gone: it was not about this bone.
  await expect(page.getByTestId('inspector-bone-add-ik-refusal')).toHaveCount(0);
  const row = page.getByTestId(`inspector-bone-ik-${layerId}`);
  await expect(row).toContainText(`reaches ${goal}`);
  await expect(page.getByTestId(`inspector-bone-ik-problem-${layerId}`)).toHaveCount(0);
  await page.evaluate(async (arm) => {
    const { dispatchMutatorFromUI } = await import('/src/app/animate/dispatchMutator.ts');
    const res = dispatchMutatorFromUI(
      'mutator.rig.editSkeleton',
      { object: arm, edit: { op: 'delete', bone: 'Bone1_tip_ik_goal', reparent: true } },
      'delete goal',
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
  }, armature);
  await expect(page.getByTestId(`inspector-bone-ik-problem-${layerId}`)).toContainText(
    `the goal bone "${goal}" is not on this skeleton`,
  );
  await page.screenshot({ path: test.info().outputPath('4-goal-deleted-says-why.png') });
});

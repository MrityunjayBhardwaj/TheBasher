// #1337 — a bone placed with the gizmo stays where it was placed when the layer it writes blends
// at half weight, or when an additive layer sits above it: the stored value is solved back through
// the blend. (A hand-pose writes only into an override layer, `whyNotHandPosable`, so those are the
// gizmo's two cases; keying into an additive layer itself is unit-tested in invertPoseStack.)
//
// The skinned bar: its base layer keys Bone1 from 0 to ~85° about Z, so at 0.6 s the stack under the
// hand-pose layer is turning. The gizmo stands with the bone's world rotation; a drag that turns it
// by +40° about world Z must leave the DRAWN bone's head→tail axis exactly where the gizmo's +Y now
// points. Stored as-is, the bone would turn by a different angle in either case.

import type { Page } from '@playwright/test';
import * as THREE from 'three';
import { test, expect } from './_fixtures';

interface W {
  __basher_dag: {
    getState: () => {
      state: {
        outputs: { scene?: { node: string } };
        nodes: Record<
          string,
          { type: string; inputs: Record<string, unknown>; params: Record<string, unknown> }
        >;
      };
      dispatchAtomic: (ops: unknown[], who: string, label: string) => void;
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_bone_gizmo?: () => { bone: string | null; quaternion: number[] } | null;
  __basher_bone_grab?: (to: { quaternion?: number[] }) => boolean;
  __basher_armature?: { names: string[]; matrices: number[][] };
}

async function setup(page: Page, weight: number, additiveAbove: boolean) {
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  await page.evaluate(
    async ({ weight, additiveAbove }) => {
      const w = window as unknown as W;
      const native = await import('/src/core/import/nativeGltfImport.ts');
      const selection = await import('/src/app/stores/selectionStore.ts');
      const modes = await import('/src/app/stores/armatureModeStore.ts');
      const bones = await import('/src/app/stores/boneSelectionStore.ts');
      const gizmo = await import('/src/app/stores/gizmoStore.ts');
      const d = await import('/src/app/animate/dispatchMutator.ts');
      const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
      const dag = w.__basher_dag.getState();
      const result = await native.buildNativeGltfImportOps({
        buffer,
        assetRef: 'user-imports/p1337/skinned-bar.glb',
        sceneNodeId: dag.state.outputs.scene!.node,
        storeImage: async () => 'unused',
      });
      if ('refused' in result) throw new Error(result.refused);
      dag.dispatchAtomic(result.ops, 'user', 'import');
      const nodes = w.__basher_dag.getState().state.nodes;
      const mod = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
      const id = (nodes[mod].inputs.armature as { node: string }).node;
      // The hand-pose layer on Bone1, at the weight under test.
      const posed = d.dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object: id, bone: 'Bone1', rotation: [0, 0, 0] },
        'seed',
      );
      if (!posed.ok) throw new Error(JSON.stringify(posed));
      const layer = (w.__basher_dag.getState().state.nodes[id].inputs.pose as { node: string })
        .node;
      w.__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: layer, paramPath: 'weight', value: weight }],
          'user',
          'layer under test',
        );
      if (additiveAbove) {
        // An additive layer above it, turning Bone1 a further 30° about X at half weight.
        w.__basher_dag.getState().dispatchAtomic(
          [
            {
              type: 'addNode',
              nodeId: 'n_p1337_add',
              nodeType: 'PoseLayer',
              params: {
                name: 'breath',
                mode: 'additive',
                weight: 0.5,
                members: [{ bone: 'Bone1', rotationMode: 'ZYX', rotation: [30, 0, 0] }],
              },
            },
            {
              type: 'connect',
              from: { node: layer, socket: 'out' },
              to: { node: 'n_p1337_add', socket: 'pose' },
            },
            {
              type: 'connect',
              from: { node: 'n_p1337_add', socket: 'out' },
              to: { node: id, socket: 'pose' },
              replace: true,
            },
          ],
          'user',
          'additive above',
        );
      }
      selection.useSelectionStore.getState().select(id);
      modes.useArmatureModeStore.getState().setMode(id, 'pose');
      bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
      gizmo.useGizmoStore.getState().setMode('rotate');
      w.__basher_time.getState().setTime(0.6);
    },
    { weight, additiveAbove },
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_bone_gizmo?.()?.bone ?? null))
    .toBe('Bone1');
}

/** The drawn Bone1's head→tail direction, after the frame catches up. */
async function drawnAxis(page: Page): Promise<THREE.Vector3> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const e = await page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature!;
    return a.matrices[a.names.indexOf('Bone1')];
  });
  return new THREE.Vector3(e[4], e[5], e[6]).normalize();
}

for (const [label, weight, additiveAbove] of [
  ['the hand-pose layer at weight 0.5', 0.5, false],
  ['an additive layer above the hand-pose layer', 1, true],
] as const) {
  test(`#1337 — a placed bone stays placed with ${label}, over a moving base`, async ({ page }) => {
    await setup(page, weight, additiveAbove);
    // Wait for the gizmo to stand at the bone as drawn at 0.6 s.
    const before = await drawnAxis(page);
    await expect
      .poll(async () => {
        const q = (await page.evaluate(() => (window as unknown as W).__basher_bone_gizmo!()!))
          .quaternion;
        return new THREE.Vector3(0, 1, 0)
          .applyQuaternion(new THREE.Quaternion(...(q as [number, number, number, number])))
          .dot(before);
      })
      .toBeGreaterThan(0.99999);
    const q0 = (await page.evaluate(() => (window as unknown as W).__basher_bone_gizmo!()!))
      .quaternion as [number, number, number, number];
    const turned = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), (40 * Math.PI) / 180)
      .multiply(new THREE.Quaternion(...q0));
    expect(
      await page.evaluate(
        (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
        turned.toArray(),
      ),
    ).toBe(true);
    const want = new THREE.Vector3(0, 1, 0).applyQuaternion(turned);
    const got = await drawnAxis(page);
    expect(
      got.dot(want),
      `drawn axis ${got.toArray()} vs placed ${want.toArray()}`,
    ).toBeGreaterThan(0.99999);
  });
}

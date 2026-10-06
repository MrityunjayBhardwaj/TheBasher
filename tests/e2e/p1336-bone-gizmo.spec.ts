// #1336 — in Pose mode the transform gizmo stands on the selected bone, and a drag poses the bone:
// the drawn bone and the skinned mesh move, the value lands in the pose layer, and the agent's verb
// writes the same member for the same pose.
//
// The skinned bar again (p1244, p1338): Bone1's head at (0, 1, 0), the tip at (0.2, 2, 0), its rest
// frame aligned with the world, and at 0 s the clip holds it at rest. Turned +90° about world Z at
// its head, the tip lands at (−1, 1.2, 0) (p1244's oracle). The drag runs through the gizmo's own
// begin / move / end (the curve point gizmo's seam): pointer synthesis through TransformControls
// is unreliable headless, and the seam calls the same functions the drag does.

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
      undoStack: unknown[];
    };
  };
  __basher_time: { getState: () => { setTime: (s: number) => void } };
  __basher_bone_gizmo?: () => {
    bone: string | null;
    position: number[];
    quaternion: number[];
  } | null;
  __basher_bone_grab?: (to: {
    position?: number[];
    quaternion?: number[];
    scale?: number[];
  }) => boolean;
  __basher_gltf_skin?: () => {
    count: number;
    rest: (i: number) => [number, number, number];
    vertex: (i: number) => [number, number, number];
  } | null;
  __basher_three: {
    getState: () => {
      scene: {
        traverse: (
          fn: (o: {
            isTransformControls?: boolean;
            object?: { position: { toArray: () => number[] } };
          }) => void,
        ) => void;
      } | null;
    };
  };
}

async function setup(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_dag?.getState().state.outputs.scene),
  );
  const id = await page.evaluate(async () => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const selection = await import('/src/app/stores/selectionStore.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1336/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = w.__basher_dag.getState().state.nodes;
    const modifier = Object.entries(nodes).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes[modifier].inputs.armature as { node: string }).node;
    selection.useSelectionStore.getState().select(armature);
    w.__basher_time.getState().setTime(0);
    return armature;
  });
  return id;
}

/** Every mounted transform gizmo: where the object it is attached to stands. */
const gizmos = (page: Page) =>
  page.evaluate(() => {
    const out: number[][] = [];
    (window as unknown as W).__basher_three.getState().scene?.traverse((o) => {
      if (o.isTransformControls && o.object) {
        out.push(o.object.position.toArray().map((c) => Math.round(c * 1e4) / 1e4));
      }
    });
    return out;
  });

async function enterPoseAndPick(page: Page, armature: string) {
  await page.evaluate(async (id) => {
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'pose');
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
  }, armature);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__basher_bone_gizmo?.()?.bone ?? null))
    .toBe('Bone1');
}

const setGizmoMode = (page: Page, mode: 'translate' | 'rotate' | 'scale') =>
  page.evaluate(async (m) => {
    const g = await import('/src/app/stores/gizmoStore.ts');
    g.useGizmoStore.getState().setMode(m);
  }, mode);

async function tip(page: Page): Promise<number[]> {
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
    .toBe(true);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const s = (window as unknown as W).__basher_gltf_skin!()!;
    let i = 0;
    for (let k = 1; k < s.count; k++) {
      const r = s.rest(k);
      const best = s.rest(i);
      if (r[1] > best[1] + 1e-6 || (Math.abs(r[1] - best[1]) <= 1e-6 && r[0] > best[0])) i = k;
    }
    const rest = s.rest(i);
    // The tip's place in the file, carried by where the drawn skin rests.
    return s.vertex(i).map((c, k) => c - rest[k] + [0.2, 2, 0][k]);
  });
}

const member = (page: Page, armature: string) =>
  page.evaluate((id) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const feed = (nodes[id].inputs.pose as { node: string }).node;
    return (nodes[feed].params.members as { bone: string }[]).find((m) => m.bone === 'Bone1');
  }, armature);

test('#1336 — the gizmo stands on the bone in Pose mode, and a rotate drag poses it', async ({
  page,
}) => {
  const armature = await setup(page);
  // Object mode: one gizmo, on the armature Object, which stands at the origin.
  await expect.poll(() => gizmos(page)).toEqual([[0, 0, 0]]);

  await enterPoseAndPick(page, armature);
  // Pose mode: the object gizmo has yielded, and the one gizmo stands at Bone1's head.
  await expect.poll(() => gizmos(page)).toEqual([[0, 1, 0]]);

  await setGizmoMode(page, 'rotate');
  const undoBefore = await page.evaluate(
    () => (window as unknown as W).__basher_dag.getState().undoStack.length,
  );
  // +90° about world Z, at the head.
  const s = Math.SQRT1_2;
  expect(
    await page.evaluate(
      (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
      [0, 0, s, s],
    ),
  ).toBe(true);

  const m = (await member(page, armature)) as { rotation: number[] };
  m.rotation.forEach((c, k) => expect(c, `member rotation ${k}`).toBeCloseTo([0, 0, 90][k], 6));
  (await tip(page)).forEach((c, k) => expect(c, `tip axis ${k}`).toBeCloseTo([-1, 1.2, 0][k], 3));
  // The whole drag is one undo step.
  expect(
    await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undoStack.length),
  ).toBe(undoBefore + 1);

  // The agent's verb, given the value the gizmo wrote, writes the same member.
  const fromGizmo = JSON.stringify(await member(page, armature));
  const fromAgent = await page.evaluate(
    async ({ id, rotation }) => {
      const w = window as unknown as W;
      const nodes = w.__basher_dag.getState().state.nodes;
      const feed = (nodes[id].inputs.pose as { node: string }).node;
      w.__basher_dag
        .getState()
        .dispatchAtomic(
          [{ type: 'setParam', nodeId: feed, paramPath: 'members', value: [] }],
          'user',
          'reset',
        );
      const d = await import('/src/app/animate/dispatchMutator.ts');
      const res = d.dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object: id, bone: 'Bone1', rotation },
        'agent',
      );
      if (!res.ok) throw new Error(JSON.stringify(res));
      const after = w.__basher_dag.getState().state.nodes[feed].params.members as {
        bone: string;
      }[];
      return JSON.stringify(after.find((x) => x.bone === 'Bone1'));
    },
    { id: armature, rotation: m.rotation },
  );
  expect(fromAgent).toBe(fromGizmo);
});

test('#1336 — a translate drag moves the bone’s head, read in its parent’s frame', async ({
  page,
}) => {
  const armature = await setup(page);
  await enterPoseAndPick(page, armature);
  await setGizmoMode(page, 'translate');
  await page.evaluate(() =>
    (window as unknown as W).__basher_bone_grab!({ position: [0.5, 1, 0] }),
  );
  const m = (await member(page, armature)) as { position: number[]; rotation?: number[] };
  m.position.forEach((c, k) => expect(c, `member position ${k}`).toBeCloseTo([0.5, 1, 0][k], 6));
  // A translate drag authors position only.
  expect(m.rotation).toBeUndefined();
  (await tip(page)).forEach((c, k) => expect(c, `tip axis ${k}`).toBeCloseTo([0.7, 2, 0][k], 3));
  // The gizmo follows the head it moved.
  await expect.poll(() => gizmos(page)).toEqual([[0.5, 1, 0]]);
});

test('#1336 — leaving Pose mode gives the gizmo back to the Object', async ({ page }) => {
  const armature = await setup(page);
  await enterPoseAndPick(page, armature);
  await expect.poll(() => gizmos(page)).toEqual([[0, 1, 0]]);
  await page.evaluate(async () => {
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().clear();
  });
  await expect.poll(() => gizmos(page)).toEqual([[0, 0, 0]]);
  void armature;
});

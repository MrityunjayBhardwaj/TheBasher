// #1344 — a bone's joint limit stops the gizmo: a rotate drag past the limit leaves the bone AT the
// limit, drawn and stored, and a value written past it by the panel or the agent draws at the limit.
//
// The skinned bar (p1336): Bone1's head at (0, 1, 0), the tip at (0.2, 2, 0), its rest frame aligned
// with the world, so a turn about world Z at its head is its Z turn from rest. Free, +90° puts the tip
// at (−1, 1.2, 0). Limited to Z in [−30°, 45°] it stops at 45°: the tip at
// (0.2·cos45 − sin45, 1 + 0.2·sin45 + cos45, 0) = (−0.5657, 1.8485, 0).
//
// The limit is set in the bone panel in Edit mode (the rows a director uses), the drag runs through
// the gizmo's own begin / move / end seam, as p1336's does.

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
      assetRef: 'user-imports/p1344/skinned-bar.glb',
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

const TIP_AT_45 = [0.2 * Math.SQRT1_2 - Math.SQRT1_2, 1 + 0.2 * Math.SQRT1_2 + Math.SQRT1_2, 0];
const S = Math.SQRT1_2;

const grab90 = (page: Page) =>
  page.evaluate(
    (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
    [0, 0, S, S],
  );

async function limitInPanel(page: Page, armature: string) {
  await page.evaluate(async (id) => {
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    const bones = await import('/src/app/stores/boneSelectionStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'edit');
    bones.useBoneSelectionStore.getState().selectBone(id, 'Bone1', ['Bone0', 'Bone1']);
  }, armature);
  const box = page.getByTestId('edit-bone-limit-z');
  await expect(box).toBeVisible();
  await expect(page.getByTestId('edit-bone-limit-z-max')).toBeDisabled();
  await box.check();
  // Switched on, an axis starts at a half turn each way.
  await expect(page.getByTestId('edit-bone-limit-z-max')).toHaveValue('180');
  await page.getByTestId('edit-bone-limit-z-max').fill('45');
  await page.getByTestId('edit-bone-limit-z-min').fill('-30');
}

const storedLimits = (page: Page) =>
  page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const skeleton = Object.values(nodes).find((n) => n.type === 'Skeleton')!;
    const bone = (
      skeleton.params.bones as { name: string; limits?: Record<string, number[]> }[]
    ).find((b) => b.name === 'Bone1')!;
    return bone.limits ?? null;
  });

test('#1344 — a rotate drag past a joint limit stops at the limit, drawn and stored', async ({
  page,
}, testInfo) => {
  const armature = await setup(page);

  // Free: the drag turns the bone the whole 90° (the fixture really passes the limit set below).
  await enterPoseAndPick(page, armature);
  await setGizmoMode(page, 'rotate');
  expect(await grab90(page)).toBe(true);
  (await tip(page)).forEach((c, k) => expect(c, `free tip ${k}`).toBeCloseTo([-1, 1.2, 0][k], 3));
  await page.evaluate(() =>
    (window as unknown as { __basher_dag: { getState: () => { undo: () => void } } }).__basher_dag
      .getState()
      .undo(),
  );
  (await tip(page)).forEach((c, k) => expect(c, `undone tip ${k}`).toBeCloseTo([0.2, 2, 0][k], 3));

  await limitInPanel(page, armature);
  const limits = (await storedLimits(page))!;
  expect(Object.keys(limits)).toEqual(['z']);
  expect(limits.z[0]).toBeCloseTo((-30 * Math.PI) / 180, 9);
  expect(limits.z[1]).toBeCloseTo((45 * Math.PI) / 180, 9);

  await enterPoseAndPick(page, armature);
  await setGizmoMode(page, 'rotate');
  expect(await grab90(page)).toBe(true);
  (await tip(page)).forEach((c, k) => expect(c, `held tip ${k}`).toBeCloseTo(TIP_AT_45[k], 3));
  // Stored at the limit, not past it: what is kept is what is drawn.
  const m = (await member(page, armature)) as { rotation: number[] };
  m.rotation.forEach((c, k) => expect(c, `member rotation ${k}`).toBeCloseTo([0, 0, 45][k], 6));
  await page.screenshot({ path: testInfo.outputPath('held-at-45.png') });

  // The other way: −90° stops at −30°.
  expect(
    await page.evaluate(
      (q) => (window as unknown as W).__basher_bone_grab!({ quaternion: q }),
      [0, 0, -S, S],
    ),
  ).toBe(true);
  const back = (await member(page, armature)) as { rotation: number[] };
  expect(back.rotation[2]).toBeCloseTo(-30, 6);
});

test('#1344 — a value written past the limit by the agent is kept as written and drawn at the limit', async ({
  page,
}) => {
  const armature = await setup(page);
  await limitInPanel(page, armature);
  await enterPoseAndPick(page, armature);
  const res = await page.evaluate(async (id) => {
    const d = await import('/src/app/animate/dispatchMutator.ts');
    return d.dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: id, bone: 'Bone1', rotation: [0, 0, 90] },
      'agent',
    );
  }, armature);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  const m = (await member(page, armature)) as { rotation: number[] };
  expect(m.rotation[2]).toBeCloseTo(90, 6);
  (await tip(page)).forEach((c, k) => expect(c, `held tip ${k}`).toBeCloseTo(TIP_AT_45[k], 3));

  // Clearing the limit in the panel lets the stored 90° show.
  await page.evaluate(async (id) => {
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'edit');
  }, armature);
  await page.getByTestId('edit-bone-limit-z').uncheck();
  expect(await storedLimits(page)).toBeNull();
  await page.evaluate(async (id) => {
    const modes = await import('/src/app/stores/armatureModeStore.ts');
    modes.useArmatureModeStore.getState().setMode(id, 'pose');
  }, armature);
  (await tip(page)).forEach((c, k) => expect(c, `freed tip ${k}`).toBeCloseTo([-1, 1.2, 0][k], 3));
});

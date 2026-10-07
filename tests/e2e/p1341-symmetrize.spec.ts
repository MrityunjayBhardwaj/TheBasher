// #1341 — symmetrize a left arm in Edit mode from the panel: a right arm appears, its joints the
// left ones mirrored across x = 0, parented by flipped name; and in Pose mode the same rotation on
// both forearms poses them as mirror images.
//
// Built on Add › Armature (Bone → Bone_end, a unit up) with the agent's verbs: an upper arm and a
// forearm extruded off to +x and named `_L`. The armature stands at the origin, so the drawn
// (world) heads are the skeleton's own, and the mirror is x → −x.

import type { Page } from '@playwright/test';
import { test, expect, settleViewFit } from './_fixtures';

interface Bone {
  name: string;
  parent: number;
}
interface W {
  __basher_dag: {
    getState: () => {
      state: { nodes: Record<string, { type: string; params: Record<string, unknown> }> };
    };
  };
  __basher_armature?: { names: string[]; matrices: number[][] };
  __basher_three: {
    getState: () => { controlsTarget: { set: (x: number, y: number, z: number) => void } | null };
  };
}

async function drawn(page: Page) {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return page.evaluate(() => {
    const a = (window as unknown as W).__basher_armature!;
    return Object.fromEntries(
      a.names.map((n, i) => {
        const m = a.matrices[i];
        return [
          n,
          { head: [m[12], m[13], m[14]], tail: [m[12] + m[4], m[13] + m[5], m[14] + m[6]] },
        ];
      }),
    ) as Record<string, { head: number[]; tail: number[] }>;
  });
}
const mirrored = (a: number[], b: number[]) => Math.hypot(a[0] + b[0], a[1] - b[1], a[2] - b[2]);

test('#1341 — symmetrize a left arm from the panel; equal rotations pose the two arms as mirror images', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  // #1523 — this spec writes the camera by hand: wait out the boot view fit, which would land after.
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const id = await page.evaluate(async () => {
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0);
    const add = await import('/src/app/AddMenu.tsx');
    add.addPrimitive('Armature');
    const s = await import('/src/app/stores/selectionStore.ts');
    const object = s.useSelectionStore.getState().primaryNodeId!;
    const d = await import('/src/app/animate/dispatchMutator.ts');
    const steps: [string, unknown][] = [
      [
        'mutator.rig.editSkeleton',
        { object, edit: { op: 'extrude', from: 'Bone_end', offset: [0.4, 0.3, 0] } },
      ],
      ['mutator.animate.renameBone', { object, bone: 'Bone_end_001', name: 'UpperArm_L' }],
      [
        'mutator.rig.editSkeleton',
        {
          object,
          edit: { op: 'extrude', from: 'UpperArm_L', offset: [0.45, -0.1, 0.1], name: 'Forearm_L' },
        },
      ],
    ];
    for (const [verb, spec] of steps) {
      const r = d.dispatchMutatorFromUI(verb, spec, 'build');
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
    return object;
  });

  await page.getByTestId('armature-mode').selectOption('edit');
  await page.evaluate(async (object) => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore
      .getState()
      .selectBone(object, 'UpperArm_L', ['Bone', 'Bone_end', 'UpperArm_L']);
  }, id);
  await page.getByTestId('edit-bone-symmetrize').click();
  await expect(page.getByTestId('edit-bone-refusal')).toHaveCount(0);

  const bones = await page.evaluate(() => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    const skel = Object.values(nodes).find(
      (n) => n.type === 'Skeleton' && (n.params.bones as Bone[])[0]?.name === 'Bone',
    )!;
    const list = skel.params.bones as Bone[];
    return list.map((b) => [b.name, b.parent < 0 ? null : list[b.parent].name]);
  });
  expect(bones).toEqual([
    ['Bone', null],
    ['Bone_end', 'Bone'],
    ['UpperArm_L', 'Bone_end'],
    ['Forearm_L', 'UpperArm_L'],
    ['UpperArm_R', 'Bone_end'],
    ['Forearm_R', 'UpperArm_R'],
  ]);
  const rest = await drawn(page);
  for (const side of ['UpperArm', 'Forearm']) {
    expect(mirrored(rest[`${side}_L`].head, rest[`${side}_R`].head), `${side} head`).toBeLessThan(
      1e-4,
    );
  }

  // Pose mode: the same rotation on both forearms; the drawn forearms are mirror images.
  await page.getByTestId('armature-mode').selectOption('pose');
  await page.evaluate(async (object) => {
    const d = await import('/src/app/animate/dispatchMutator.ts');
    for (const bone of ['Forearm_L', 'Forearm_R']) {
      const r = d.dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object, bone, rotation: [25, -40, 60] },
        'pose',
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
  }, id);
  const posed = await drawn(page);
  expect(mirrored(posed.Forearm_L.tail, posed.Forearm_R.tail), 'forearm tails mirror').toBeLessThan(
    1e-4,
  );
  // And the pose did something: the tail moved from rest.
  expect(
    Math.hypot(...posed.Forearm_L.tail.map((c, k) => c - rest.Forearm_L.tail[k])),
  ).toBeGreaterThan(0.05);
});

// The arm's IK mirrors with it: Shift+I on a left hand in Pose mode, then symmetrize the arm from the
// Edit panel. The right arm gets its own IK — chain, goal and pole flipped to the right side — the
// right controls stand at the left ones mirrored, and the right goal moves the right hand.
test('#1341 — symmetrizing an arm with an IK gives the twin arm its own IK', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  // #1523 — this spec writes the camera by hand: wait out the boot view fit, which would land after.
  await settleViewFit(page);
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const id = await page.evaluate(async () => {
    (window as unknown as W).__basher_three.getState().controlsTarget!.set(0, 0, 0);
    const add = await import('/src/app/AddMenu.tsx');
    add.addPrimitive('Armature');
    const s = await import('/src/app/stores/selectionStore.ts');
    const object = s.useSelectionStore.getState().primaryNodeId!;
    const d = await import('/src/app/animate/dispatchMutator.ts');
    const steps: [string, unknown][] = [
      [
        'mutator.rig.editSkeleton',
        { object, edit: { op: 'extrude', from: 'Bone_end', offset: [0.4, 0.3, 0] } },
      ],
      ['mutator.animate.renameBone', { object, bone: 'Bone_end_001', name: 'UpperArm_L' }],
      [
        'mutator.rig.editSkeleton',
        {
          object,
          edit: { op: 'extrude', from: 'UpperArm_L', offset: [0.45, -0.1, 0.1], name: 'Forearm_L' },
        },
      ],
      [
        'mutator.rig.editSkeleton',
        {
          object,
          edit: { op: 'extrude', from: 'Forearm_L', offset: [0.3, 0.25, -0.1], name: 'Hand_L' },
        },
      ],
    ];
    for (const [verb, spec] of steps) {
      const r = d.dispatchMutatorFromUI(verb, spec, 'build');
      if (!r.ok) throw new Error(JSON.stringify(r));
    }
    return object;
  });

  // Pose mode: Shift+I on the left hand.
  await page.getByTestId('armature-mode').selectOption('pose');
  await page.evaluate(async (object) => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore
      .getState()
      .selectBone(object, 'Hand_L', ['Bone', 'Bone_end', 'UpperArm_L', 'Forearm_L', 'Hand_L']);
    (document.activeElement as HTMLElement | null)?.blur();
  }, id);
  await page.keyboard.press('Shift+I');
  await expect(page.getByTestId(`inspector-bone-ik-${id}_ik_Hand_L`)).toBeVisible();

  // Edit mode: symmetrize the arm from the upper arm.
  await page.getByTestId('armature-mode').selectOption('edit');
  await page.evaluate(async (object) => {
    const b = await import('/src/app/stores/boneSelectionStore.ts');
    b.useBoneSelectionStore
      .getState()
      .selectBone(object, 'UpperArm_L', ['Bone', 'Bone_end', 'UpperArm_L']);
  }, id);
  await page.getByTestId('edit-bone-symmetrize').click();
  await expect(page.getByTestId('edit-bone-refusal')).toHaveCount(0);

  const twin = await page.evaluate((layer) => {
    const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
    return nodes[layer]?.params.ik as Record<string, unknown> | undefined;
  }, `${id}_ik_Hand_R`);
  expect(twin).toMatchObject({
    root: 'UpperArm_R',
    mid: 'Forearm_R',
    tip: 'Hand_R',
    goal: 'Hand_ik_goal_R',
    pole: 'Hand_ik_pole_R',
  });

  await page.getByTestId('armature-mode').selectOption('pose');
  // Look at the arms from the front, above the starter box.
  await page.evaluate(() => {
    const t = (
      window as unknown as {
        __basher_three: {
          getState: () => {
            camera: { position: { set: (x: number, y: number, z: number) => void } };
            controlsTarget: { set: (x: number, y: number, z: number) => void } | null;
          };
        };
      }
    ).__basher_three.getState();
    t.controlsTarget!.set(0, 1.7, 0);
    t.camera.position.set(0, 2.4, 4);
  });
  const at = await drawn(page);
  for (const name of ['UpperArm', 'Forearm', 'Hand', 'Hand_ik_goal', 'Hand_ik_pole']) {
    expect(mirrored(at[`${name}_L`].head, at[`${name}_R`].head), `${name} mirrors`).toBeLessThan(
      1e-4,
    );
  }
  await page.screenshot({ path: test.info().outputPath('ik-1-mirrored.png') });

  // The right goal moves the right hand to it.
  const to = [-0.7, 1.9, 0.4];
  await page.evaluate(
    async ([object, p]) => {
      const d = await import('/src/app/animate/dispatchMutator.ts');
      const r = d.dispatchMutatorFromUI(
        'mutator.animate.poseBone',
        { object, bone: 'Hand_ik_goal_R', position: p },
        'move goal',
      );
      if (!r.ok) throw new Error(JSON.stringify(r));
    },
    [id, to] as const,
  );
  await expect
    .poll(async () => Math.hypot(...(await drawn(page)).Hand_R.head.map((c, k) => c - to[k])))
    .toBeLessThan(1e-4);
  await page.screenshot({ path: test.info().outputPath('ik-2-right-goal-moved.png') });
});

// #1357 — a Rig in the live app: wrapping a character's IK layer in a Rig changes nothing it draws.
//
// The rig of `p1343-ik-layer.spec.ts`: the skinned bar imported native, a tip joint and a root control
// bone `goal` added through the product's rig verb, and an ik layer on top with its weight keyed
// 0 at 0 s → 1 at 1 s. Then the inspector's own button, "wrap in a Rig", on the armature Object:
//   - the ik layer is inside a Rig node, and the Object's pose reads the Rig;
//   - the skin is where it was at 0 s (FK), 0.5 s (blending) and 1 s (IK), vertex for vertex;
//   - at 1 s the drawn tip joint still sits on the drawn goal;
//   - nothing is left to wrap, so the button is gone; one undo brings the layer back onto the wire
//     and the skin is still where it was.

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
      undo: () => void;
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

const GOAL: [number, number, number] = [1.2, 1.2, 0.4];

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

test('#1357 — wrapping an ik layer in a Rig leaves the character where it was', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('layout')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean((window as unknown as W).__basher_three?.getState().controlsTarget),
  );
  const { armature, tip } = await page.evaluate(async (goal) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const { dispatchMutatorFromUI } = await import('/src/app/animate/dispatchMutator.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1357/skinned-bar.glb',
      sceneNodeId: dag.state.outputs.scene!.node,
      storeImage: async () => 'unused',
    });
    if ('refused' in result) throw new Error(result.refused);
    dag.dispatchAtomic(result.ops, 'user', 'import gltf (native, skinned)');
    const nodes = () => w.__basher_dag.getState().state.nodes;
    const mod = Object.entries(nodes()).find(([, n]) => n.type === 'ArmatureModifier')![0];
    const armature = (nodes()[mod].inputs.armature as { node: string }).node;
    const edit = (e: unknown) => {
      const res = dispatchMutatorFromUI(
        'mutator.rig.editSkeleton',
        { object: armature, edit: e },
        'edit',
      );
      if (!res.ok) throw new Error(JSON.stringify(res));
    };
    edit({ op: 'extrude', from: 'Bone1', name: 'Bone1_tip' });
    edit({ op: 'add', parent: null, position: goal, name: 'goal' });
    const skeleton = (nodes()[armature].inputs.data as { node: string }).node;
    const bones = (nodes()[skeleton].params.bones as { name: string }[]).map((b) => b.name);
    const tip = bones.find((b) => b.startsWith('Bone1_tip'))!;
    const feed = nodes()[armature].inputs.pose as { node: string; socket: string };
    dag.dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'n_p1357_ik',
          nodeType: 'PoseLayer',
          params: {
            name: 'bar ik',
            mode: 'ik',
            ik: { root: 'Bone0', mid: 'Bone1', tip, goal: 'goal' },
            channels: [
              {
                component: 'weight',
                keyframes: [
                  { time: 0, value: 0, easing: 'linear' },
                  { time: 1, value: 1, easing: 'linear' },
                ],
              },
            ],
          },
        },
        { type: 'connect', from: feed, to: { node: 'n_p1357_ik', socket: 'pose' } },
        {
          type: 'connect',
          from: { node: 'n_p1357_ik', socket: 'out' },
          to: { node: armature, socket: 'pose' },
          replace: true,
        },
      ],
      'user',
      'add ik layer',
    );
    return { armature, tip, fk: feed };
  }, GOAL);
  await page.evaluate(() => {
    const t = (window as unknown as W).__basher_three.getState();
    t.controlsTarget!.set(0.5, 1.2, 0);
    t.camera.position.set(0.5, 1.2, 5);
  });
  await page.getByTestId(`scene-tree-row-${armature}`).click();
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as W).__basher_gltf_skin?.())))
    .toBe(true);

  const TIMES = [0, 0.5, 1];
  const skinAt = async (t: number) => {
    await page.evaluate((s) => (window as unknown as W).__basher_time.getState().setTime(s), t);
    return skin(page);
  };
  const wiring = () =>
    page.evaluate((arm) => {
      const nodes = (window as unknown as W).__basher_dag.getState().state.nodes;
      const pose = nodes[arm].inputs.pose as { node: string };
      const reads = nodes[pose.node];
      return {
        objectReads: reads.type,
        body: (reads.inputs.body as { node: string } | undefined)?.node ?? null,
        ikReads: nodes[(nodes['n_p1357_ik'].inputs.pose as { node: string }).node].type,
        rigs: Object.values(nodes).filter((n) => n.type === 'Rig').length,
      };
    }, armature);

  // Before: the ik layer is on the Object's own wire.
  expect(await wiring()).toMatchObject({ objectReads: 'PoseLayer', rigs: 0 });
  const before: number[][][] = [];
  for (const t of TIMES) before.push(await skinAt(t));
  // The premise: the layer about to be wrapped moves the bar, so "unchanged" is not vacuous.
  expect(maxDelta(before[2], before[0]), 'the solve moves the bar').toBeGreaterThan(0.1);
  await page.screenshot({ path: test.info().outputPath('1-before-wrap-1s.png') });

  // The gesture, through the inspector.
  await expect(page.getByTestId('inspector-wrap-in-rig')).toContainText('1 layer from the IK up');
  await page.getByTestId('inspector-wrap-in-rig-button').click();
  await expect(page.getByTestId('inspector-wrap-in-rig-done')).toHaveText(
    '1 layer is inside a Rig',
  );
  await expect(page.getByTestId('inspector-wrap-in-rig-button')).toHaveCount(0);
  expect(await wiring()).toEqual({
    objectReads: 'Rig',
    body: 'n_p1357_ik',
    ikReads: 'BodyInputPose',
    rigs: 1,
  });

  // After: the same skin at every time.
  for (const [i, t] of TIMES.entries()) {
    expect(maxDelta(await skinAt(t), before[i]), `the skin at ${t} s`).toBeLessThan(1e-6);
  }
  const [tipAt, goalAt] = [await headOf(page, tip), await headOf(page, 'goal')];
  expect(
    Math.max(...tipAt.map((c, k) => Math.abs(c - goalAt[k]))),
    'the tip is still on the goal',
  ).toBeLessThan(1e-4);
  await page.screenshot({ path: test.info().outputPath('2-after-wrap-1s.png') });

  // One undo: the layer is back on the wire, the Rig is gone, the skin has not moved.
  await page.evaluate(() => (window as unknown as W).__basher_dag.getState().undo());
  expect(await wiring()).toMatchObject({ objectReads: 'PoseLayer', rigs: 0 });
  for (const [i, t] of TIMES.entries()) {
    expect(maxDelta(await skinAt(t), before[i]), `after undo, the skin at ${t} s`).toBeLessThan(
      1e-6,
    );
  }
});

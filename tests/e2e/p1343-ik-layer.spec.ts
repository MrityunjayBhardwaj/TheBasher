// #1343 — an ik pose layer in the live app: the skinned bar's chain reaches a control bone, and a keyed
// weight switches FK → IK.
//
// The skinned bar imported native: Bone0 → Bone1, its clip turning Bone1. Through the product's own
// rig verb, a tip joint is extruded from Bone1 (the bar's end) and a root control bone `goal` is added
// off to the side. An ik layer (root Bone0, mid Bone1, tip the new joint, goal `goal`) goes on top of
// the chain with its weight keyed 0 at 0 s → 1 at 1 s.
//   - at 0 s the weight is 0: the skin is exactly what the FK alone draws;
//   - at 1 s the weight is 1: the drawn tip joint sits on the drawn goal, and the bar has moved.

import type { Page } from '@playwright/test';
import { test, expect, settleViewFit } from './_fixtures';

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

test('#1343 — an ik layer reaches the control bone, and its keyed weight switches FK to IK', async ({
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
  const { armature, tip } = await page.evaluate(async (goal) => {
    const w = window as unknown as W;
    const native = await import('/src/core/import/nativeGltfImport.ts');
    const { dispatchMutatorFromUI } = await import('/src/app/animate/dispatchMutator.ts');
    const buffer = await fetch('/assets/skinned-bar.glb').then((r) => r.arrayBuffer());
    const dag = w.__basher_dag.getState();
    const result = await native.buildNativeGltfImportOps({
      buffer,
      assetRef: 'user-imports/p1343/skinned-bar.glb',
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
          nodeId: 'n_p1343_ik',
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
        { type: 'connect', from: feed, to: { node: 'n_p1343_ik', socket: 'pose' } },
        {
          type: 'connect',
          from: { node: 'n_p1343_ik', socket: 'out' },
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

  // 0 s: weight 0 — the skin the FK alone draws. The FK is read by unhooking the ik layer for a frame.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(0));
  const at0 = await skin(page);
  await page.screenshot({ path: test.info().outputPath('1-weight-0-fk.png') });
  const fk0 = await page.evaluate(() => {
    const w = window as unknown as W;
    const dag = w.__basher_dag.getState();
    const ik = dag.state.nodes['n_p1343_ik'];
    dag.dispatchAtomic(
      [{ type: 'setParam', nodeId: 'n_p1343_ik', paramPath: 'mute', value: true }],
      'user',
      'mute ik',
    );
    return Boolean(ik);
  });
  expect(fk0).toBe(true);
  expect(maxDelta(await skin(page), at0), 'weight 0 draws the FK exactly').toBeLessThan(1e-6);
  await page.evaluate(() =>
    (window as unknown as W).__basher_dag
      .getState()
      .dispatchAtomic(
        [{ type: 'setParam', nodeId: 'n_p1343_ik', paramPath: 'mute', value: false }],
        'user',
        'unmute ik',
      ),
  );

  // 1 s: weight 1 — the tip joint on the goal bone, as drawn.
  await page.evaluate(() => (window as unknown as W).__basher_time.getState().setTime(1));
  await expect
    .poll(async () => {
      const [t, g] = [await headOf(page, tip), await headOf(page, 'goal')];
      return Math.max(...t.map((c, k) => Math.abs(c - g[k])));
    })
    .toBeLessThan(1e-4);
  const at1 = await skin(page);
  await page.screenshot({ path: test.info().outputPath('2-weight-1-ik.png') });
  expect(maxDelta(at1, at0), 'the solve moved the bar').toBeGreaterThan(0.1);
  // The bar is one-sided and faces the camera (+z) at rest. The solve must not twist it round: its
  // first quad still faces +z (a 162° root twist once showed only its back face — nothing drawn).
  const facing = (v: number[][]) => {
    const a = v[1].map((c, k) => c - v[0][k]);
    const b = v[2].map((c, k) => c - v[0][k]);
    return a[0] * b[1] - a[1] * b[0];
  };
  expect(facing(at0)).toBeGreaterThan(0);
  expect(facing(at1), 'the bar still faces the camera').toBeGreaterThan(0);
});

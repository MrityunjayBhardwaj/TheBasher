// #1337 — the value stored in a pose layer reproduces the pose the director placed, whatever the
// layer's mode and weight and whatever sits above it.
//
// The oracle is the product's own evaluation: store the value `layerValueForDrawn` returns, evaluate
// the armature Object, and read the bone back. Subject: skinned-bar.glb imported native, whose base
// layer keys Bone1's rotation from 0 to ~85° about Z, so the stack under any hand-pose layer moves.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import type { ObjectValue, PosedSkeletonValue, Quat, Vec3 } from '../../nodes/types';
import type { PoseLayerMember, PoseLayerParams } from '../../nodes/PoseLayer';
import { eulerFromQuat, quatFromEuler } from '../../nodes/bonePose';
import { characterTargets } from '../asset/bindMotionToCharacter';
import { handPoseOps } from '../../agent/mutators/builders/poseBone';
import { handPoseLayerOf } from './poseChain';
import type { GraphNodeLike } from './graphNodes';
import { layerValueForDrawn, type ComponentValue } from './invertPoseStack';
import type { PoseComponent } from './poseTargetForBone';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const DEG = Math.PI / 180;
const T = 0.6;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const set = (state: DagState, id: string, path: string, value: unknown) =>
  apply(state, [{ type: 'setParam', nodeId: id, paramPath: path, value } as Op]);

async function bar(): Promise<{ state: DagState; armature: string; layer: string }> {
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const s0 = buildDefaultDagState();
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: s0.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = apply(s0, result.ops);
  const armature = characterTargets(state)[0].objectId!;
  // A hand-pose layer over the moving base, holding a pose in every component.
  state = apply(
    state,
    handPoseOps(state, armature, 'Bone1', {
      position: [0.1, 1, 0],
      rotation: [0, 10, 20],
      scale: [1, 1.2, 1],
    }),
  );
  return { state, armature, layer: handPoseLayerOf(graph(state), armature)! };
}

function drawnBone1(state: DagState, armature: string, component: PoseComponent): ComponentValue {
  const value = evaluate(state, armature, {
    ctx: { time: { frame: 0, seconds: T, normalized: 0 } } as never,
  }).value as ObjectValue;
  const b = (value as { pose?: PosedSkeletonValue })
    .pose!.sample(T)
    .find((p) => p.name === 'Bone1')!;
  return component === 'rotation' ? b.quaternion : component === 'position' ? b.position : b.scale;
}

/** Write `value` into Bone1's member of `layer`, in the member's units. */
function store(
  state: DagState,
  layer: string,
  component: PoseComponent,
  value: ComponentValue,
): DagState {
  const members = (state.nodes[layer].params as PoseLayerParams).members.map(
    (m): PoseLayerMember =>
      m.bone !== 'Bone1'
        ? m
        : {
            ...m,
            [component]:
              component === 'rotation'
                ? eulerFromQuat(value as Quat, 'ZYX').map((r) => r / DEG)
                : [...(value as Vec3)],
          },
  );
  return set(state, layer, 'members', members);
}

function expectSame(component: PoseComponent, got: ComponentValue, want: ComponentValue) {
  if (component === 'rotation') {
    const d = Math.abs(got.reduce((s, x, i) => s + x * want[i], 0));
    expect(
      d,
      `rotation off by ${((2 * Math.acos(Math.min(1, d))) / DEG).toFixed(4)}°`,
    ).toBeGreaterThan(1 - 1e-9);
  } else {
    got.forEach((x, i) => expect(x, `${component}[${i}]`).toBeCloseTo(want[i], 7));
  }
}

const TARGET: Record<PoseComponent, ComponentValue> = {
  position: [0.4, 0.8, -0.2],
  rotation: quatFromEuler([25 * DEG, -15 * DEG, 40 * DEG], 'ZYX'),
  scale: [1.5, 0.7, 1.1],
};
const COMPONENTS: PoseComponent[] = ['position', 'rotation', 'scale'];

describe('#1337 — the stored value reproduces the placed pose', () => {
  for (const [mode, weight] of [
    ['additive', 0.5],
    ['override', 0.5],
    ['additive', 1],
    ['override', 1],
  ] as const) {
    for (const component of COMPONENTS) {
      it(`${mode} at ${weight}, ${component}`, async () => {
        const seeded = await bar();
        const { armature, layer } = seeded;
        let state = seeded.state;
        state = set(set(state, layer, 'mode', mode), layer, 'weight', weight);
        const res = layerValueForDrawn(
          state,
          armature,
          layer,
          'Bone1',
          component,
          TARGET[component],
          T,
        );
        expect(res.ok, JSON.stringify(res)).toBe(true);
        const after = store(state, layer, component, (res as { value: ComponentValue }).value);
        expectSame(component, drawnBone1(after, armature, component), TARGET[component]);
      });
    }
  }

  it('the case that needs it: storing the placed value as-is misses the pose (additive at 0.5)', async () => {
    const seeded = await bar();
    const { armature, layer } = seeded;
    let state = seeded.state;
    state = set(set(state, layer, 'mode', 'additive'), layer, 'weight', 0.5);
    const naive = drawnBone1(
      store(state, layer, 'rotation', TARGET.rotation),
      armature,
      'rotation',
    );
    const d = Math.abs(naive.reduce((s, x, i) => s + x * TARGET.rotation[i], 0));
    expect(d).toBeLessThan(0.999);
  });

  it('through two layers above: an additive at 0.7 and an override at 0.4', async () => {
    const seeded = await bar();
    const { armature, layer } = seeded;
    let state = seeded.state;
    state = set(set(state, layer, 'mode', 'additive'), layer, 'weight', 0.5);
    for (const [id, mode, weight, pose] of [
      [
        'n_up_add',
        'additive',
        0.7,
        { position: [0.05, 0, 0.1], rotation: [5, 0, -12], scale: [1.1, 1, 0.9] },
      ],
      [
        'n_up_over',
        'override',
        0.4,
        { position: [0, 1.2, 0], rotation: [0, 30, 0], scale: [0.8, 1, 1] },
      ],
    ] as const) {
      const feed = state.nodes[armature].inputs.pose as { node: string; socket: string };
      state = apply(state, [
        {
          type: 'addNode',
          nodeId: id,
          nodeType: 'PoseLayer',
          params: {
            name: id,
            mode,
            weight,
            members: [{ bone: 'Bone1', rotationMode: 'ZYX', ...pose }],
          },
        },
        {
          type: 'connect',
          from: { node: feed.node, socket: feed.socket },
          to: { node: id, socket: 'pose' },
        },
        {
          type: 'connect',
          from: { node: id, socket: 'out' },
          to: { node: armature, socket: 'pose' },
          replace: true,
        },
      ] as Op[]);
    }
    for (const component of COMPONENTS) {
      const res = layerValueForDrawn(
        state,
        armature,
        layer,
        'Bone1',
        component,
        TARGET[component],
        T,
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
      const after = store(state, layer, component, (res as { value: ComponentValue }).value);
      expectSame(component, drawnBone1(after, armature, component), TARGET[component]);
    }
  });

  it('is refused, by name, under a layer that overrides the bone at full weight', async () => {
    const seeded = await bar();
    const { armature, layer } = seeded;
    let state = seeded.state;
    const feed = state.nodes[armature].inputs.pose as { node: string; socket: string };
    state = apply(state, [
      {
        type: 'addNode',
        nodeId: 'n_top',
        nodeType: 'PoseLayer',
        params: {
          name: 'top',
          mode: 'override',
          weight: 1,
          members: [{ bone: 'Bone1', rotationMode: 'ZYX', rotation: [0, 0, 5] }],
        },
      },
      {
        type: 'connect',
        from: { node: feed.node, socket: feed.socket },
        to: { node: 'n_top', socket: 'pose' },
      },
      {
        type: 'connect',
        from: { node: 'n_top', socket: 'out' },
        to: { node: armature, socket: 'pose' },
        replace: true,
      },
    ] as Op[]);
    const res = layerValueForDrawn(state, armature, layer, 'Bone1', 'rotation', TARGET.rotation, T);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/"top" above overrides Bone1's rotation/);
    // A component that layer leaves alone is still solvable through it.
    expect(
      layerValueForDrawn(state, armature, layer, 'Bone1', 'position', TARGET.position, T).ok,
    ).toBe(true);
  });
});

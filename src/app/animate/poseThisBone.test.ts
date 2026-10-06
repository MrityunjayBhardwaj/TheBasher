// #1474 — "pose this bone" starts from the pose on screen: clicking it on a moving bone changes
// nothing drawn at the playhead. (It used to seed rotation 0, which froze the bone at rest.)
//
// The oracle is the product's own evaluation: every bone of the armature Object, sampled at the
// playhead, before and after the click. Subject: skinned-bar.glb imported native, whose base layer
// keys Bone1's rotation from 0 to ~85° about Z, so the bone is moving where it is clicked.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BonePose, ObjectValue, PosedSkeletonValue } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { characterTargets } from '../asset/bindMotionToCharacter';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { useTimeStore } from '../stores/timeStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { poseObjectBoneAsShown } from './autoKeyCommit';
import { poseTargetForBone, type ObjectPoseTarget } from './poseTargetForBone';
import { handPoseLayerOf } from './poseChain';
import type { GraphNodeLike } from './graphNodes';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
  useAutoKeyStore.setState({ enabled: false });
});

const T = 0.6;
const live = () => useDagStore.getState().state;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

async function bar(): Promise<{ state: DagState; armature: string }> {
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
  const state = apply(s0, result.ops);
  return { state, armature: characterTargets(state)[0].objectId! };
}

/** Every bone of the armature as drawn at the playhead. */
function drawn(armature: string): readonly BonePose[] {
  const value = evaluate(live(), armature, {
    ctx: { time: { frame: T * 24, seconds: T, normalized: 0 } } as never,
  }).value as ObjectValue;
  return (value as { pose?: PosedSkeletonValue }).pose!.sample(T);
}

function expectSameBones(after: readonly BonePose[], before: readonly BonePose[]) {
  expect(after.map((b) => b.name)).toEqual(before.map((b) => b.name));
  after.forEach((b, i) => {
    const w = before[i];
    const dot = Math.abs(b.quaternion.reduce((s, x, k) => s + x * w.quaternion[k], 0));
    expect(dot, `${b.name} rotation`).toBeGreaterThan(1 - 1e-9);
    b.position.forEach((x, k) =>
      expect(x, `${b.name} position[${k}]`).toBeCloseTo(w.position[k], 9),
    );
    b.scale.forEach((x, k) => expect(x, `${b.name} scale[${k}]`).toBeCloseTo(w.scale[k], 9));
  });
}

/** Click "pose this bone" on Bone1 at T, as the inspector's button does. */
function click(armature: string) {
  useTimeStore.getState().setTime(T);
  const target = poseTargetForBone(live(), armature, 'Bone1', T) as ObjectPoseTarget;
  expect(target.rotation, 'Bone1 must not be posed yet — the button shows only then').toBeNull();
  const res = poseObjectBoneAsShown(target);
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

const bone1Member = (armature: string) => {
  const layer = handPoseLayerOf(graph(live()), armature)!;
  return (live().nodes[layer].params as PoseLayerParams).members.find((m) => m.bone === 'Bone1');
};

/**
 * An additive layer on top of the armature's pose wire that turns Bone1 on two axes — a layer a
 * hand-pose never lands in (`handPoseLayerOf` skips it), so what arrives under the hand-pose layer is
 * NOT what the Object reads, and an euler in the wrong order is a different rotation.
 */
function withAdditiveOnTop(state: DagState, armature: string): DagState {
  const feed = state.nodes[armature].inputs!.pose as { node: string; socket: string };
  return apply(state, [
    {
      type: 'addNode',
      nodeId: 'n_adjust',
      nodeType: 'PoseLayer',
      params: {
        name: 'adjust',
        mode: 'additive',
        members: [{ bone: 'Bone1', rotationMode: 'ZYX', rotation: [10, 20, 0] }],
      },
    },
    { type: 'connect', from: feed, to: { node: 'n_adjust', socket: 'pose' } },
    {
      type: 'connect',
      from: { node: 'n_adjust', socket: 'out' },
      to: { node: armature, socket: 'pose' },
      replace: true,
    },
  ] as Op[]);
}

describe('#1474 — "pose this bone" leaves the bone as drawn at the playhead', () => {
  it('inserting the hand-pose layer under a moving bone', async () => {
    const { state, armature } = await bar();
    useDagStore.getState().hydrate(state);
    expect(handPoseLayerOf(graph(live()), armature)).toBeNull();
    const before = drawn(armature);
    // Not vacuous: Bone1 is turned away from its rest (identity) at T.
    expect(Math.abs(before.find((b) => b.name === 'Bone1')!.quaternion[3])).toBeLessThan(0.99);

    click(armature);

    expect(bone1Member(armature)?.rotation, 'the click authored a rotation').toBeDefined();
    expectSameBones(drawn(armature), before);
  });

  it('into an existing hand-pose layer at half weight', async () => {
    const { state, armature } = await bar();
    useDagStore.getState().hydrate(state);
    const posed = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: armature, bone: 'Bone0', rotation: [0, 0, 30] },
      'pose',
    );
    expect(posed.ok, JSON.stringify(posed)).toBe(true);
    const layer = handPoseLayerOf(graph(live()), armature)!;
    useDagStore
      .getState()
      .hydrate(
        apply(live(), [{ type: 'setParam', nodeId: layer, paramPath: 'weight', value: 0.5 }]),
      );
    const before = drawn(armature);

    click(armature);

    expect(bone1Member(armature)?.rotation).toBeDefined();
    expectSameBones(drawn(armature), before);
  });

  it('under an additive layer that turns the bone on two axes', async () => {
    const { state, armature } = await bar();
    useDagStore.getState().hydrate(withAdditiveOnTop(state, armature));
    const before = drawn(armature);

    click(armature);

    expect(bone1Member(armature)?.rotation).toBeDefined();
    expectSameBones(drawn(armature), before);
  });

  it('into an existing hand-pose layer with an additive layer above it', async () => {
    const { state, armature } = await bar();
    useDagStore.getState().hydrate(state);
    const posed = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: armature, bone: 'Bone0', rotation: [0, 0, 30] },
      'pose',
    );
    expect(posed.ok, JSON.stringify(posed)).toBe(true);
    const layer = handPoseLayerOf(graph(live()), armature)!;
    useDagStore.getState().hydrate(withAdditiveOnTop(live(), armature));
    // The pose still lands in the hand-pose layer, below the additive one.
    expect(handPoseLayerOf(graph(live()), armature)).toBe(layer);
    const before = drawn(armature);

    click(armature);

    expect(bone1Member(armature)?.rotation).toBeDefined();
    expectSameBones(drawn(armature), before);
  });

  it("with no pose wire, the seed is the bone's rest, not zero", async () => {
    const { state, armature } = await bar();
    // Bone1 rests turned 0.5 rad about Z, and the Object reads no pose wire: it draws the rest.
    const skeleton = state.nodes[armature].inputs!.data as { node: string };
    const bones = (state.nodes[skeleton.node].params as { bones: { rotation: number[] }[] }).bones;
    const feed = state.nodes[armature].inputs!.pose as { node: string; socket: string };
    const restTurned = apply(state, [
      {
        type: 'setParam',
        nodeId: skeleton.node,
        paramPath: 'bones',
        value: bones.map((b, i) => (i === 1 ? { ...b, rotation: [0, 0, 0.5] } : b)),
      },
      { type: 'disconnect', from: feed, to: { node: armature, socket: 'pose' } },
    ]);
    useDagStore.getState().hydrate(restTurned);
    // Nothing arrives, so the Object carries no pose to sample: the bone stands at its rest.
    expect((evaluate(live(), armature).value as { pose?: unknown }).pose).toBeUndefined();

    click(armature);

    // A member replaces the bone's local transform, so the seed that keeps it is its rest.
    const rotation = bone1Member(armature)!.rotation!;
    [0, 0, 0.5 * (180 / Math.PI)].forEach((r, k) =>
      expect(rotation[k], `rotation[${k}]`).toBeCloseTo(r, 9),
    );
  });
});

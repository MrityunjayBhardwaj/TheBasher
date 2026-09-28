// #1215 — a native bone's rotation in the inspector keys where the hand-pose lives, as Blender's
// pose-bone Rotation field does under Auto-Key.
//
// Blender 5.1.1: a field's auto-key keys ONLY a property that already has an F-curve
// (`button_anim_autokey` → `autokeyframe_property(..., only_if_property_keyed = true)`,
// `interface_anim.cc:318-321`, early return in `keyframing_auto.cc`); without one the edit only sets
// the value. The key button is I over the field: it keys the value shown.
//
// Subject: skinned-bar.glb imported native; Bone1 hand-posed to 30° about Z, which inserts the
// hand-pose layer under the Object.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import type { ObjectValue, PosedSkeletonValue } from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { characterTargets } from '../asset/bindMotionToCharacter';
import { useAutoKeyStore } from '../stores/autoKeyStore';
import { useTimeStore } from '../stores/timeStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { commitObjectBoneRotation, keyObjectBoneRotation } from './autoKeyCommit';
import { poseTargetForBone, type ObjectPoseTarget } from './poseTargetForBone';
import { handPoseLayerOf, poseLayerChain } from './poseChain';
import type { GraphNodeLike } from './graphNodes';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
  useAutoKeyStore.setState({ enabled: false });
});

const live = () => useDagStore.getState().state;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);
const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const setTime = (seconds: number) => useTimeStore.getState().setTime(seconds);

async function posedBar(): Promise<{ armature: string; layer: string }> {
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
  const armature = characterTargets(state)[0].objectId!;
  useDagStore.getState().hydrate(state);
  const posed = dispatchMutatorFromUI(
    'mutator.animate.poseBone',
    { object: armature, bone: 'Bone1', rotation: [0, 0, 30] },
    'pose',
  );
  expect(posed.ok, JSON.stringify(posed)).toBe(true);
  return { armature, layer: handPoseLayerOf(graph(live()), armature)! };
}

const target = (armature: string, seconds = useTimeStore.getState().seconds) =>
  poseTargetForBone(live(), armature, 'Bone1', seconds) as ObjectPoseTarget;

const curveOf = (state: DagState, layer: string) =>
  (state.nodes[layer].params as PoseLayerParams).channels.find(
    (c) => c.bone === 'Bone1' && c.component === 'rotation',
  );

function bone1At(state: DagState, armature: string, seconds: number) {
  const value = evaluate(state, armature, { ctx: at(seconds) }).value as ObjectValue;
  return (value as { pose?: PosedSkeletonValue })
    .pose!.sample(seconds)
    .find((b) => b.name === 'Bone1')!.quaternion;
}

const angleBetween = (a: readonly number[], b: readonly number[]) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

describe('#1215 — a native bone rotation keys where the hand-pose lives', () => {
  it('the row reads the layer the pose writes: unkeyed, its static rotation', async () => {
    const { armature, layer } = await posedBar();
    const t = target(armature, 0);
    expect(t.layerId).toBe(layer);
    expect(t.keyed).toBe(false);
    expect(t.rotation).toEqual([0, 0, 30]);
  });

  it('the key button keys the rotation shown, at the playhead, in that layer', async () => {
    const { armature, layer } = await posedBar();
    setTime(0.5);
    const res = keyObjectBoneRotation(target(armature));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const curve = curveOf(live(), layer)!;
    expect(curve.keyframes.map((k) => [k.time, k.value])).toEqual([[0.5, [0, 0, 30]]]);
    expect(target(armature).keyed).toBe(true);
  });

  it('keyed + Auto-Key on: an edit is a key at the playhead; the field shows the curve as played', async () => {
    const { armature, layer } = await posedBar();
    setTime(0);
    expect(keyObjectBoneRotation(target(armature)).ok).toBe(true);
    useAutoKeyStore.setState({ enabled: true });
    setTime(1);
    const staticBefore = (live().nodes[layer].params as PoseLayerParams).members.find(
      (m) => m.bone === 'Bone1',
    )!.rotation;
    const res = commitObjectBoneRotation(target(armature), [0, 0, 90]);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const curve = curveOf(live(), layer)!;
    expect(curve.keyframes.map((k) => [k.time, k.value])).toEqual([
      [0, [0, 0, 30]],
      [1, [0, 0, 90]],
    ]);
    // The member's static value is untouched: the key is the edit.
    expect(
      (live().nodes[layer].params as PoseLayerParams).members.find((m) => m.bone === 'Bone1')!
        .rotation,
    ).toEqual(staticBefore);
    // The field at each time is the curve there; the bone plays it.
    expect(target(armature, 1).rotation).toEqual([0, 0, 90]);
    expect(target(armature, 0).rotation).toEqual([0, 0, 30]);
    const mid = target(armature, 0.5).rotation!;
    expect(mid[2]).toBeGreaterThan(30);
    expect(mid[2]).toBeLessThan(90);
    expect(
      angleBetween(bone1At(live(), armature, 1), bone1At(live(), armature, 0)),
      'the bone turns 60° between the keys',
    ).toBeCloseTo(60, 3);
  });

  it('keyed + Auto-Key off: refused with the reason, nothing written', async () => {
    const { armature } = await posedBar();
    setTime(0);
    expect(keyObjectBoneRotation(target(armature)).ok).toBe(true);
    const before = live();
    setTime(1);
    const res = commitObjectBoneRotation(target(armature), [0, 0, 90]);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/Auto-Key/);
    expect(live()).toBe(before);
  });

  it('unkeyed + Auto-Key on: the edit only sets the value, as a Blender field does (no curve made)', async () => {
    const { armature, layer } = await posedBar();
    useAutoKeyStore.setState({ enabled: true });
    setTime(1);
    const res = commitObjectBoneRotation(target(armature), [0, 0, 60]);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(curveOf(live(), layer)).toBeUndefined();
    expect(target(armature).rotation).toEqual([0, 0, 60]);
  });

  it('a layer stacked above the hand-pose layer does not change which one the row reads', async () => {
    const { armature, layer } = await posedBar();
    // An additive layer inserted between the hand-pose layer and the Object: the chain's top is now
    // a layer a hand-pose never writes into.
    const additive = 'n_additive_on_top';
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: additive,
          nodeType: 'PoseLayer',
          params: { name: 'adds', mode: 'additive', members: [] },
        },
        {
          type: 'connect',
          from: { node: layer, socket: 'out' },
          to: { node: additive, socket: 'pose' },
        },
        {
          type: 'connect',
          from: { node: additive, socket: 'out' },
          to: { node: armature, socket: 'pose' },
          replace: true,
        },
      ],
      'user',
    );
    expect(poseLayerChain(graph(live()), armature).layers[0]).toBe(additive);
    const t = target(armature, 0);
    expect(t.layerId).toBe(layer);
    expect(t.rotation).toEqual([0, 0, 30]);
  });
});

// #1244 — hand-posing a native character writes into the pose layer feeding its armature Object.
//
// Through the product's verb (`mutator.animate.poseBone`, anchored on the Object), which both the
// agent and the inspector's pose row call. The oracle is arithmetic on the rig, not our sampler:
// Bone1's head is (0, 1, 0) and the bar's top vertices are wholly Bone1's, so a posed rotation R
// puts a top vertex at head + R·(rest − head). The rotation is the verb's one meaning, degrees in the
// codebase's order, which is Blender's ZYX.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import { poseTargetForBone } from '../animate/poseTargetForBone';
import { poseLayerChain } from '../animate/poseChain';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { quatFromEuler } from '../../nodes/bonePose';
import { qmul } from '../../nodes/quatMath';
import type { GraphNodeLike } from '../animate/graphNodes';
import type { BoneSpec, MeshGeometryData, Quat, SkinDeformValue } from '../../nodes/types';
import { useSelectionStore } from '../stores/selectionStore';
import { bindMotionToCharacter } from './bindMotionToCharacter';

const DEG = Math.PI / 180;
const at = (seconds: number) => ({
  ctx: { time: { frame: seconds * 24, seconds, normalized: 0 } },
});

const SWING_BVH = `HIERARCHY
ROOT Bone0
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Bone1
  {
    OFFSET 0 1 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 1 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.5
0 0 0 0 0 0 0 0 0
0 0 0 0 0 30 45 0 0
0 0 0 0 0 60 90 0 0
`;

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

async function bar(): Promise<{ state: DagState; armatureId: string; modifierId: string }> {
  let state = buildDefaultDagState();
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: state.outputs.scene!.node,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  for (const op of result.ops) state = applyOp(state, op).next;
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const armatureId = (state.nodes[modifierId].inputs.armature as { node: string }).node;
  return { state, armatureId, modifierId };
}

function withSwing(state: DagState): DagState {
  const motion = buildBvhImportOps({
    text: SWING_BVH,
    name: 'swing',
    ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
  });
  for (const op of motion.ops) state = applyOp(state, op).next;
  const stand = buildSkeletonObjectOps({
    skeletonId: 'swing_skel',
    bones: (state.nodes.swing_skel.params as { bones: BoneSpec[] }).bones,
    sceneNodeId: state.outputs.scene!.node,
    normalise: false,
    name: 'swing',
    clipId: 'swing_clip',
    nameFollowsClip: true,
  });
  for (const op of stand.ops) state = applyOp(state, op).next;
  return state;
}

const pose = (object: string, bone: string, rotation: [number, number, number]) =>
  dispatchMutatorFromUI('mutator.animate.poseBone', { object, bone, rotation }, `pose ${bone}`);

function modifier(state: DagState, modifierId: string) {
  const value = evaluate(state, modifierId, at(0)).value as {
    geometry: { descriptor: { data: MeshGeometryData } };
    skin: SkinDeformValue;
  };
  return { mesh: value.geometry.descriptor.data, skin: value.skin };
}

/** Every top vertex (rest y = 2, wholly Bone1's) at head + R·(rest − head), at `seconds`. */
function expectTopTurnedBy(state: DagState, modifierId: string, q: Quat, seconds: number) {
  const { mesh, skin } = modifier(state, modifierId);
  const deformed = sampleSkinDeform(skin, mesh, seconds);
  let checked = 0;
  for (let i = 0; i < mesh.points.length / 3; i++) {
    if (mesh.points[i * 3 + 1] < 2 - 1e-6) continue;
    const v = new Vector3(mesh.points[i * 3], mesh.points[i * 3 + 1] - 1, mesh.points[i * 3 + 2]);
    v.applyQuaternion({ x: q[0], y: q[1], z: q[2], w: q[3] } as never);
    [v.x, v.y + 1, v.z].forEach((c, k) =>
      expect(deformed[i * 3 + k], `vertex ${i} axis ${k} at ${seconds}s`).toBeCloseTo(c, 5),
    );
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
}

const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

describe('#1244 — hand-posing a native character', () => {
  it('posing a bone moves its deformed vertices by exactly the pose, and it holds across frames', async () => {
    const { state, armatureId, modifierId } = await bar();
    useDagStore.getState().hydrate(state);
    const r: [number, number, number] = [10, -20, 70];
    expect(pose(armatureId, 'Bone1', r).ok).toBe(true);
    const after = useDagStore.getState().state;
    // A layer now sits between the bar's motion (its base layer, holding the file's keys, #1211) and
    // its armature Object: the pose never goes into the base, which a bind replaces.
    const chain = poseLayerChain(graph(after), armatureId);
    expect(chain.layers).toHaveLength(2);
    expect(chain.layers[1]).toBe(chain.base);
    expect(chain.source?.socket).toBe('pose');
    const q = quatFromEuler([r[0] * DEG, r[1] * DEG, r[2] * DEG], 'ZYX');
    // The bar's clip keys Bone1 the whole way (0 → ~85°); the pose holds over it at every frame.
    for (const t of [0, 0.5, 0.9]) expectTopTurnedBy(after, modifierId, q, t);
  });

  it('a second pose extends the same layer; editing a bone rewrites its member', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    expect(pose(armatureId, 'Bone1', [0, 0, 30]).ok).toBe(true);
    expect(pose(armatureId, 'Bone0', [0, 0, 5]).ok).toBe(true);
    expect(pose(armatureId, 'Bone1', [0, 0, 50]).ok).toBe(true);
    const after = useDagStore.getState().state;
    const { layers, base } = poseLayerChain(graph(after), armatureId);
    expect(layers).toEqual([layers[0], base]);
    const members = (
      after.nodes[layers[0]].params as { members: { bone: string; rotation: number[] }[] }
    ).members;
    expect(members.map((m) => [m.bone, m.rotation])).toEqual([
      ['Bone1', [0, 0, 50]],
      ['Bone0', [0, 0, 5]],
    ]);
  });

  it('the pose row finds the bone, and sees the pose once it is made', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    expect(poseTargetForBone(state, armatureId, 'Bone1')).toEqual({
      kind: 'object',
      objectId: armatureId,
      bone: 'Bone1',
      rotation: null,
      // #1215 — no hand-pose layer yet (the first pose inserts one), so nothing is keyed there.
      layerId: null,
      keyed: false,
    });
    expect(poseTargetForBone(state, armatureId, 'Tail')).toBeNull();
    pose(armatureId, 'Bone1', [0, 0, 25]);
    expect(poseTargetForBone(useDagStore.getState().state, armatureId, 'Bone1')?.kind).toBe(
      'object',
    );
    expect(
      (
        poseTargetForBone(useDagStore.getState().state, armatureId, 'Bone1') as {
          rotation: unknown;
        }
      ).rotation,
    ).toEqual([0, 0, 25]);
  });

  it('rebinding a motion keeps the pose: the retarget goes under the layer', async () => {
    const { state: s0, armatureId, modifierId } = await bar();
    useDagStore.getState().hydrate(withSwing(s0));
    useSelectionStore.getState().select(null);
    expect(pose(armatureId, 'Bone1', [0, 0, 20]).ok).toBe(true);
    const bound = bindMotionToCharacter(
      { clipId: 'swing_clip', skeletonId: 'swing_skel' },
      'imported',
    );
    expect(bound.ok, JSON.stringify(bound)).toBe(true);
    if (!bound.ok) return;
    const after = useDagStore.getState().state;
    const chain = poseLayerChain(graph(after), armatureId);
    // The edit layer, then the base: muted by the bind (#1211), the retarget under it.
    expect(chain.layers).toHaveLength(2);
    expect((after.nodes[chain.layers[1]].params as { mute: boolean }).mute).toBe(true);
    expect(chain.source).toEqual({ node: bound.clipId, socket: 'posed' });
    // Bone0 plays the new motion: 30° about Y (the bar's own axis) at 0.5 s.
    const bone0 = boneQuat(after, armatureId, 0, 0.5);
    expect(angleDeg(bone0, [0, 0, 0, 1])).toBeCloseTo(30, 4);
    // Bone1 keeps the hand-pose. Bone1's head lies on Bone0's axis, so it does not move, and the
    // top vertices turn about it by Bone0's rotation times the pose.
    expectTopTurnedBy(after, modifierId, qmul(bone0, quatFromEuler([0, 0, 20 * DEG], 'ZYX')), 0.5);
  });

  it('one undo takes the pose back, and the base poses the Object again', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    const before = state.nodes[armatureId].inputs.pose;
    pose(armatureId, 'Bone1', [0, 0, 30]);
    useDagStore.getState().undo();
    const after = useDagStore.getState().state;
    expect(after.nodes[armatureId].inputs.pose).toEqual(before);
    // Only the base layer is left.
    const layers = Object.values(after.nodes).filter((n) => n.type === 'PoseLayer');
    expect(layers.map((n) => n.id)).toEqual([(before as { node: string }).node]);
  });

  it('#1245 — posing again under an additive layer lands in the pose layer below it', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    expect(pose(armatureId, 'Bone1', [0, 0, 30]).ok).toBe(true);
    const poseLayer = poseLayerChain(graph(useDagStore.getState().state), armatureId).layers[0];
    // A director stacks an additive layer on top.
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'lean',
          nodeType: 'PoseLayer',
          params: {
            mode: 'additive',
            members: [{ bone: 'Bone0', rotationMode: 'XYZ', rotation: [0, 0, 5] }],
          },
        },
        {
          type: 'connect',
          from: { node: poseLayer, socket: 'out' },
          to: { node: 'lean', socket: 'pose' },
        },
        {
          type: 'connect',
          from: { node: 'lean', socket: 'out' },
          to: { node: armatureId, socket: 'pose' },
          replace: true,
        },
      ],
      'user',
      'add lean',
    );
    const again = pose(armatureId, 'Bone1', [0, 0, 60]);
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const after = useDagStore.getState().state;
    const { layers, base } = poseLayerChain(graph(after), armatureId);
    expect(layers).toEqual(['lean', poseLayer, base]);
    const members = (
      after.nodes[poseLayer].params as { members: { bone: string; rotation: number[] }[] }
    ).members;
    expect(members).toEqual([expect.objectContaining({ bone: 'Bone1', rotation: [0, 0, 60] })]);
  });

  it('#1245 — a chain of only additive layers gets an override layer under the Object', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    const feed = state.nodes[armatureId].inputs.pose as { node: string; socket: string };
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'addNode',
          nodeId: 'lean',
          nodeType: 'PoseLayer',
          params: { mode: 'additive', members: [] },
        },
        { type: 'connect', from: feed, to: { node: 'lean', socket: 'pose' } },
        {
          type: 'connect',
          from: { node: 'lean', socket: 'out' },
          to: { node: armatureId, socket: 'pose' },
          replace: true,
        },
      ],
      'user',
      'add lean',
    );
    expect(pose(armatureId, 'Bone1', [0, 0, 60]).ok).toBe(true);
    const chain = poseLayerChain(graph(useDagStore.getState().state), armatureId);
    expect(chain.layers).toHaveLength(3);
    expect(chain.layers[1]).toBe('lean');
    expect(chain.layers[2]).toBe(chain.base);
  });

  it('#1245 — the pose layer turned additive: a new pose is refused by name, not by an id collision', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    expect(pose(armatureId, 'Bone1', [0, 0, 30]).ok).toBe(true);
    const layer = poseLayerChain(graph(useDagStore.getState().state), armatureId).layers[0];
    useDagStore
      .getState()
      .dispatch({ type: 'setParam', nodeId: layer, paramPath: 'mode', value: 'additive' });
    const again = pose(armatureId, 'Bone1', [0, 0, 60]);
    expect(again.ok === false && again.reason).toMatch(
      /_pose_layer" is additive, not override, so it cannot take a pose/,
    );
  });

  it('refusals name themselves', async () => {
    const { state, armatureId } = await bar();
    useDagStore.getState().hydrate(state);
    const noBone = pose(armatureId, 'Tail', [0, 0, 1]);
    expect(noBone.ok === false && noBone.reason).toMatch(/not on this rig/);
    const notArmature = pose(state.outputs.scene!.node, 'Bone1', [0, 0, 1]);
    expect(notArmature.ok === false && notArmature.reason).toMatch(/not an armature Object/);
    // A pose authoring neither component is inert: refused, and nothing is left behind.
    const before = Object.keys(useDagStore.getState().state.nodes).length;
    const nothing = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: armatureId, bone: 'Bone1' },
      'nothing',
    );
    expect(nothing.ok === false && nothing.reason).toMatch(/needs position, rotation, or both/);
    expect(Object.keys(useDagStore.getState().state.nodes)).toHaveLength(before);
  });
});

/** A bone's local rotation on the armature Object's pose, at `t`. */
function boneQuat(state: DagState, armatureId: string, index: number, t: number): Quat {
  const value = evaluate(state, armatureId, at(t)).value as {
    pose: { sample: (s: number) => { quaternion: Quat }[] };
  };
  return value.pose.sample(t)[index].quaternion;
}

/** The angle between two rotations, by the metric that does not floor. */
function angleDeg(a: Quat, b: Quat): number {
  const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
  const s = Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]);
  return (4 * Math.atan2(Math.min(d, s), Math.max(d, s))) / DEG;
}

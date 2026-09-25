// #1211 — a character's BASE pose layer: the bottom override layer reading its skeleton's rest pose,
// where an imported file's motion lives as keys (step 4 of "Bones as Channels", #1233). Built here by
// hand, since an imported character and a hand-keyed one are the same nodes.
//
//   A bind replaces it, as Blender swaps an armature's action: MUTED, never removed.
//   A hand-pose never writes into it (a hand-pose survives a rebind, #1244), nor into a muted layer.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { registerAllNodes } from '../../nodes/registerAll';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import { poseLayerChain } from '../animate/poseChain';
import { poseLayerIdFor } from '../../agent/mutators/builders/poseBone';
import { armaturePoseOf, quatFromEuler } from '../../nodes/bonePose';
import type { GraphNodeLike } from '../animate/graphNodes';
import type { BoneSpec, ObjectValue, PosedSkeletonValue, Quat } from '../../nodes/types';

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

const BONES: BoneSpec[] = [
  { name: 'Bone0', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'Bone1', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
];
/** The character's own motion: Bone1 keyed from 0° to 120° about X over one second. */
const OWN_KEYS = [
  { time: 0, value: [0, 0, 0, 1], easing: 'linear' },
  { time: 1, value: [Math.sin(60 * DEG), 0, 0, Math.cos(60 * DEG)], easing: 'linear' },
];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

/** Skeleton.pose → base (override, keyed) → Object.pose, plus a swing motion to bind. */
function character(baseSource: 'rest' | 'clip' = 'rest'): DagState {
  let state = buildDefaultDagState();
  const scene = state.outputs.scene!.node;
  const motion = buildBvhImportOps({
    text: SWING_BVH,
    name: 'swing',
    ids: { skeleton: 'swing_skel', clip: 'swing_clip' },
  });
  const ops: Op[] = [
    ...motion.ops,
    { type: 'addNode', nodeId: 'sk', nodeType: 'Skeleton', params: { bones: BONES } },
    { type: 'addNode', nodeId: 'rig', nodeType: 'Object', params: {} },
    { type: 'connect', from: { node: 'sk', socket: 'out' }, to: { node: 'rig', socket: 'data' } },
    {
      type: 'connect',
      from: { node: 'rig', socket: 'out' },
      to: { node: scene, socket: 'children' },
    },
    {
      type: 'addNode',
      nodeId: 'base',
      nodeType: 'PoseLayer',
      params: {
        name: 'motion',
        mode: 'override',
        members: [{ bone: 'Bone1', rotationMode: 'quaternion' }],
        channels: [{ bone: 'Bone1', component: 'quaternion', keyframes: OWN_KEYS }],
      },
    },
    baseSource === 'rest'
      ? {
          type: 'connect',
          from: { node: 'sk', socket: 'pose' },
          to: { node: 'base', socket: 'pose' },
        }
      : {
          type: 'connect',
          from: { node: 'swing_clip', socket: 'pose' },
          to: { node: 'base', socket: 'pose' },
        },
    { type: 'connect', from: { node: 'base', socket: 'out' }, to: { node: 'rig', socket: 'pose' } },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

function bone1(state: DagState, seconds: number): Quat {
  const obj = evaluate(state, 'rig', { ...at(seconds), socket: 'out' }).value as ObjectValue;
  const pose = armaturePoseOf(obj);
  if (!pose) throw new Error('the rig has no pose');
  return pose.sample(seconds).find((b) => b.name === 'Bone1')!.quaternion;
}

function bind() {
  return dispatchMutatorFromUI(
    'mutator.animation.retarget',
    {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId: 'sk',
      targetObjectId: 'rig',
      customMap: { Bone0: 'Bone0', Bone1: 'Bone1' },
      outputClipId: 'swing_on_rig',
    },
    'bind',
  );
}

const pose = (bone: string, rotation: [number, number, number]) =>
  dispatchMutatorFromUI('mutator.animate.poseBone', { object: 'rig', bone, rotation }, 'pose');

const expectQuat = (got: Quat, want: Quat, what: string) => {
  const sign =
    got[0] * want[0] + got[1] * want[1] + got[2] * want[2] + got[3] * want[3] < 0 ? -1 : 1;
  got.forEach((c, k) => expect(sign * c, `${what} q${k}`).toBeCloseTo(want[k], 9));
};

describe('#1211 — the base pose layer', () => {
  it('is the bottom override layer reading the rest pose, and only that', () => {
    expect(poseLayerChain(graph(character('rest')), 'rig').base).toBe('base');
    // Reading a clip, the bottom layer is an edit on that clip, not the character's own motion.
    expect(poseLayerChain(graph(character('clip')), 'rig').base).toBeNull();
    // An additive layer on the rest pose is an offset, not a motion.
    let s = character('rest');
    s = applyOp(s, { type: 'setParam', nodeId: 'base', paramPath: 'mode', value: 'additive' }).next;
    expect(poseLayerChain(graph(s), 'rig').base).toBeNull();
  });

  it('a bind mutes it and plays the bound motion; the base keeps its keys', () => {
    const state = character();
    useDagStore.getState().hydrate(state);
    // Before: the rig plays its own keys (60° at 0.5 s).
    expectQuat(bone1(state, 0.5), [Math.sin(30 * DEG), 0, 0, Math.cos(30 * DEG)], 'own @0.5');
    expect(bind().ok).toBe(true);
    const after = useDagStore.getState().state;
    expect((after.nodes.base.params as { mute: boolean }).mute).toBe(true);
    expect((after.nodes.base.params as { channels: unknown[] }).channels).toHaveLength(1);
    expect(after.nodes.base.inputs.pose).toEqual({ node: 'swing_on_rig', socket: 'posed' });
    const bound = evaluate(after, 'swing_on_rig', { socket: 'posed', ...at(0) })
      .value as PosedSkeletonValue;
    for (const t of [0.5, 1]) {
      const want = bound.sample(t).find((b) => b.name === 'Bone1')!.quaternion;
      expectQuat(bone1(after, t), want, `bound @${t}`);
    }
  });

  it('a hand-pose goes into a layer above the base, and survives the bind', () => {
    const state = character();
    useDagStore.getState().hydrate(state);
    const r: [number, number, number] = [10, -20, 70];
    expect(pose('Bone1', r).ok).toBe(true);
    let after = useDagStore.getState().state;
    // Not into the base: its members are untouched, and a new layer sits under the Object.
    expect((after.nodes.base.params as { members: unknown[] }).members).toHaveLength(1);
    expect(poseLayerChain(graph(after), 'rig').layers).toEqual([poseLayerIdFor('rig'), 'base']);
    const q = quatFromEuler([r[0] * DEG, r[1] * DEG, r[2] * DEG], 'ZYX');
    expectQuat(bone1(after, 0.5), q, 'posed before bind');

    expect(bind().ok).toBe(true);
    after = useDagStore.getState().state;
    expect((after.nodes.base.params as { mute: boolean }).mute).toBe(true);
    for (const t of [0, 0.5, 1]) expectQuat(bone1(after, t), q, `posed after bind @${t}`);
  });

  it('after a bind, a hand-pose skips the muted base and lands in a new layer', () => {
    useDagStore.getState().hydrate(character());
    expect(bind().ok).toBe(true);
    expect(pose('Bone0', [0, 0, 15]).ok).toBe(true);
    const after = useDagStore.getState().state;
    expect(poseLayerChain(graph(after), 'rig').layers).toEqual([poseLayerIdFor('rig'), 'base']);
    expect(
      (after.nodes.base.params as { members: { bone: string }[] }).members.map((m) => m.bone),
    ).toEqual(['Bone1']);

    // That layer muted too: refused by its own cause, not by an id collision.
    useDagStore.getState().dispatch({
      type: 'setParam',
      nodeId: poseLayerIdFor('rig'),
      paramPath: 'mute',
      value: true,
    });
    const again = pose('Bone0', [0, 0, 25]);
    expect(again.ok === false && again.reason).toMatch(
      /_pose_layer" is muted, so it cannot take a pose/,
    );
  });
});

// #1215 — a bake turns computed motion into keys on a pose layer, and the character moves exactly as
// before, as Blender's "Bake Action" leaves it.
//
// Oracle: `ref/probes/blender-native-character/q1215_bake_oracle.py` (Blender 5.1.1) imports
// `skinned-bar-two-clips.glb` (#1154) and bakes its armature with the NLA bake's core
// (`anim_utils.bake_action_objects`, visual keying, every bone, location/rotation/scale) at frame step
// 1 and step 6, then plays the baked action alone. It dumps every baked curve (25 / 5 LINEAR keys, a new
// action in REPLACE) and every deformed vertex at frames 0..24 — stored in
// `src/core/import/__fixtures__/blender-oracle-1215.json`. The file keys a rotation at every frame, so
// Blender's per-component quaternion curves and our slerp agree at every integer frame; between the
// step-6 keys they agree at the midpoints only (design D-D), so step 6 is compared at keys + midpoints.
//
// Blender has no retarget (design R12), so a baked RETARGET is compared with the live retarget it came
// from: the bake at every pose leaves every vertex where it was, at every frame.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { emptyDagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import type { Op } from '../../core/dag/types';
import { buildNativeGltfImportOps } from '../../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import type {
  BoneSpec,
  MeshGeometryData,
  ModifiedDataValue,
  PosedSkeletonValue,
} from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { useSelectionStore } from '../stores/selectionStore';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { bindMotionToCharacter, characterTargets } from '../asset/bindMotionToCharacter';
import {
  bakePose,
  bakeTimes,
  bakedLayerIdFor,
  bakedLayerParams,
  freeBakedLayerId,
  type BakePoseArgs,
} from './bakePose';
import { poseLayerChain } from './poseChain';
import type { GraphNodeLike } from './graphNodes';
import oracle from '../../core/import/__fixtures__/blender-oracle-1215.json';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

type Deform = Record<string, number[][][]>;
type Curve = [string, number, number[], string[]];
const ORACLE = oracle as unknown as {
  base: { deform: Deform };
  step1: { action: string; blend: string; curves: Curve[]; deform: Deform };
  step6: { action: string; blend: string; curves: Curve[]; deform: Deform };
};
const TOL = 1e-6;
const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;
const nodesOf = (state: DagState, type: string) =>
  Object.values(state.nodes).filter((n) => n.type === type);
const apply = (state: DagState, ops: readonly Op[]) =>
  ops.reduce((s, op) => applyOp(s, op).next, state);

function bytesOf(file: string): ArrayBuffer {
  const bytes = readFileSync(`public/assets/${file}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importNative(state: DagState, file: string, sceneNodeId: string): Promise<DagState> {
  const result = await buildNativeGltfImportOps({
    buffer: bytesOf(file),
    assetRef: `user-imports/native/${file}`,
    sceneNodeId,
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  return apply(state, sceneNodeId === 'n_scene' ? result.ops.slice(0, -1) : result.ops);
}

const armatureOf = (state: DagState) =>
  nodesOf(state, 'Object').find(
    (n) =>
      state.nodes[(n.inputs.data as { node: string } | undefined)?.node ?? '']?.type === 'Skeleton',
  )!.id;

/** The deformed mesh at `seconds`, as the modifier deforms it. */
function deformAt(
  state: DagState,
  seconds: number,
): { rest: Float32Array | number[]; out: Float32Array } {
  const modifierId = nodesOf(state, 'ArmatureModifier')[0].id;
  const value = evaluate(state, modifierId, { ctx: at(seconds) }).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
  const mesh = descriptor.data as MeshGeometryData;
  return {
    rest: mesh.points as unknown as number[],
    out: sampleSkinDeform(value.skin, mesh, seconds),
  };
}

/** Every deformed vertex against the oracle at `frames`, looked up by rest point. */
function expectDeformLike(state: DagState, want: Deform, frames: readonly number[], label: string) {
  const key = (p: ArrayLike<number>, i: number) =>
    [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]
      .map((v) => String(Math.round(v * 1e4) / 1e4 + 0))
      .join(',');
  let compared = 0;
  let worst = 0;
  for (const frame of frames) {
    const { rest, out } = deformAt(state, frame / 24);
    const byRest = new Map<string, number[]>();
    for (let i = 0; i < rest.length / 3; i++)
      byRest.set(key(rest, i), [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    for (const [r, w] of want[String(frame)]) {
      const v = byRest.get(key(r, 0));
      expect(v, `${label}: vertex resting at ${r}`).toBeDefined();
      w.forEach((c, k) => {
        worst = Math.max(worst, Math.abs(v![k] - c));
        expect(Math.abs(v![k] - c), `${label} f${frame} ${r} axis ${k}`).toBeLessThan(TOL);
      });
      compared++;
    }
  }
  return { compared, worst };
}

const FRAMES_ALL = Array.from({ length: 25 }, (_, i) => i);
const FRAMES_KEYS_AND_MIDS = Array.from({ length: 9 }, (_, i) => i * 3);

/** The bar with only its first animation playing (the held take muted, as imported). */
async function bar() {
  const state = await importNative(emptyDagState(), 'skinned-bar-two-clips.glb', 'n_scene');
  const armature = armatureOf(state);
  const chain = poseLayerChain(graph(state), armature);
  return { state, armature, chain };
}

function baked(state: DagState, args: BakePoseArgs) {
  const result = bakePose(state, args);
  if (!result.ok) throw new Error(result.reason);
  return { state: apply(state, result.ops), report: result.report };
}

describe('#1215 — a bake, against Blender’s Bake Action', () => {
  it('the bar deforms as Blender’s before any bake, at every frame (the oracle’s own control)', async () => {
    const { state } = await bar();
    expect(expectDeformLike(state, ORACLE.base.deform, FRAMES_ALL, 'base').compared).toBe(25 * 6);
  });

  it('every pose: one key per pose of every bone’s position, rotation and scale, linear — Blender’s curves', async () => {
    const { state: s0, armature, chain } = await bar();
    const layerId = bakedLayerIdFor(armature);
    const { state, report } = baked(s0, {
      object: armature,
      at: chain.base!,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId,
    });
    expect(report.times.map((t) => Math.round(t * 24 * 1e6) / 1e6)).toEqual(FRAMES_ALL);
    expect(report.muted).toEqual([chain.base]);
    expect(
      (state.nodes[chain.base!].params as PoseLayerParams).mute,
      'folded in: muted, kept',
    ).toBe(true);
    expect(
      report.detached,
      'the chain stood on the rest pose: nothing computed to detach',
    ).toBeNull();

    // The structure Blender's bake writes: every bone, location + quaternion + scale, one key per
    // frame, all LINEAR — here each bone a quaternion member, three channels.
    const params = state.nodes[layerId].params as PoseLayerParams;
    expect(params.mode).toBe('override');
    expect(params.members.map((m) => [m.bone, m.rotationMode])).toEqual([
      ['Bone0', 'quaternion'],
      ['Bone1', 'quaternion'],
    ]);
    const blenderCurves = ORACLE.step1.curves;
    expect(blenderCurves).toHaveLength(20);
    const components = {
      location: 'position',
      rotation_quaternion: 'quaternion',
      scale: 'scale',
    } as const;
    for (const [path, , frames, interps] of blenderCurves) {
      const [, bone, prop] = /pose\.bones\["(.+)"\]\.(\w+)/.exec(path)!;
      const channel = params.channels.find(
        (c) => c.bone === bone && c.component === components[prop as keyof typeof components],
      );
      expect(channel, `${bone} ${prop}`).toBeDefined();
      expect(channel!.keyframes.map((k) => Math.round(k.time * 24 * 1e4) / 1e4)).toEqual(frames);
      expect(interps).toEqual(['LINEAR']);
      expect(new Set(channel!.keyframes.map((k) => (k as { easing?: string }).easing))).toEqual(
        new Set(['linear']),
      );
    }
    expect(params.channels).toHaveLength(6);
    expect(ORACLE.step1.blend).toBe('REPLACE');

    // The baked layer is the chain's base now: an override on the rest pose, at the bottom.
    const after = poseLayerChain(graph(state), armature);
    expect(after.base).toBe(layerId);
    expect(after.source).toEqual({ node: chain.source!.node, socket: 'pose' });

    // Every vertex, every frame, played from the baked keys alone (the file's keys are muted).
    const { worst } = expectDeformLike(state, ORACLE.step1.deform, FRAMES_ALL, 'step 1');
    expect(worst).toBeLessThan(TOL);
  });

  it('every 6th pose: 0, 6, 12, 18, 24 — Blender’s frame step, compared at the keys and midpoints', async () => {
    const { state: s0, armature, chain } = await bar();
    const layerId = bakedLayerIdFor(armature);
    const { state, report } = baked(s0, {
      object: armature,
      at: chain.base!,
      poses: { kind: 'nth', n: 6 },
      interpolation: 'linear',
      layerId,
    });
    expect(report.times.map((t) => Math.round(t * 24 * 1e6) / 1e6)).toEqual([0, 6, 12, 18, 24]);
    for (const [, , frames] of ORACLE.step6.curves) expect(frames).toEqual([0, 6, 12, 18, 24]);
    expectDeformLike(state, ORACLE.step6.deform, FRAMES_KEYS_AND_MIDS, 'step 6');
    // Not the unbaked motion between keys: the thinning is real.
    const between = expectDeformLikeOrNull(state, ORACLE.base.deform, 3);
    expect(
      between,
      'between two 6-frame keys the bake is linear, not the file’s curve',
    ).toBeGreaterThan(1e-4);
  });
});

/** The largest vertex difference from `want` at one frame. */
function expectDeformLikeOrNull(state: DagState, want: Deform, frame: number): number {
  const { out } = deformAt(state, frame / 24);
  const { rest } = deformAt(state, frame / 24);
  let worst = 0;
  for (const [r, w] of want[String(frame)]) {
    for (let i = 0; i < rest.length / 3; i++) {
      if ([0, 1, 2].every((k) => Math.abs(rest[i * 3 + k] - r[k]) < 1e-4)) {
        w.forEach((c, k) => (worst = Math.max(worst, Math.abs(out[i * 3 + k] - c))));
      }
    }
  }
  return worst;
}

/** A two-joint motion named as the bar's bones: `Bone1` swings 0° → 45° → 90° about Z over a second. */
const BAR_SWING_BVH = `HIERARCHY
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
0 0 0 0 0 0 45 0 0
0 0 0 0 0 0 90 0 0
`;

function importMotion(state: DagState, id: string, text: string): DagState {
  const motion = buildBvhImportOps({
    text,
    name: id,
    ids: { skeleton: `${id}_skel`, layer: `${id}_motion` },
  });
  state = apply(state, motion.ops);
  const bones = (state.nodes[`${id}_skel`].params as { bones: BoneSpec[] }).bones;
  const stand = buildSkeletonObjectOps({
    skeletonId: `${id}_skel`,
    bones,
    sceneNodeId: state.outputs.scene!.node,
    normalise: false,
    name: id,
    pose: { node: `${id}_motion`, socket: 'out' },
    nameFollowsClip: false,
  });
  return apply(state, stand.ops);
}

/** The bar with the swing bound onto it through the product's bind. */
async function boundBar() {
  const s0 = buildDefaultDagState();
  const withBar = await importNative(s0, 'skinned-bar.glb', s0.outputs.scene!.node);
  const state0 = importMotion(withBar, 'swing', BAR_SWING_BVH);
  const armature = characterTargets(state0)[0].objectId!;
  useDagStore.getState().hydrate(state0);
  useSelectionStore.getState().select(null);
  const bound = bindMotionToCharacter(
    { motionId: 'swing_motion', skeletonId: 'swing_skel' },
    'imported',
  );
  if (!bound.ok) throw new Error(JSON.stringify(bound));
  return { state: useDagStore.getState().state, armature, retarget: bound.clipId };
}

describe('#1215 — baking a retarget: the live link ends, the motion does not change', () => {
  it('bakes the retarget at every pose: every vertex where it was, at every frame; the retarget is kept, detached', async () => {
    const { state: s0, armature, retarget } = await boundBar();
    const layerId = freeBakedLayerId(s0, armature);
    const { state, report } = baked(s0, {
      object: armature,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId,
    });
    expect(report.detached).toEqual({ node: retarget, socket: 'posed' });
    expect(report.muted, 'baking the source folds no layer in').toEqual([]);
    expect(state.nodes[retarget], 'kept: a regenerable source, not deleted').toBeDefined();
    const chain = poseLayerChain(graph(state), armature);
    expect(chain.base).toBe(layerId);
    expect(chain.source?.node).not.toBe(retarget);

    let worst = 0;
    for (let f = 0; f <= 24; f++) {
      const before = deformAt(s0, f / 24).out;
      const after = deformAt(state, f / 24).out;
      before.forEach((c, i) => (worst = Math.max(worst, Math.abs(after[i] - c))));
    }
    expect(worst, 'every vertex at every frame, baked vs live').toBeLessThan(TOL);
    // The control: the swing really moves the tip, so an unmoved deform would fail above.
    const a = deformAt(s0, 0).out;
    const b = deformAt(s0, 1).out;
    expect(Math.max(...Array.from(a, (c, i) => Math.abs(b[i] - c)))).toBeGreaterThan(0.5);

    // The pose the Object carries is the retarget's, key for key.
    const live = evaluate(s0, retarget, { socket: 'posed', ctx: at(0) })
      .value as PosedSkeletonValue;
    const params = state.nodes[layerId].params as PoseLayerParams;
    expect(params.members.map((m) => m.bone)).toEqual(live.skeleton.bones.map((b) => b.name));
  });

  it('a hand-pose layer above the retarget keeps editing what arrives after the bake', async () => {
    const { state: bound, armature } = await boundBar();
    useDagStore.getState().hydrate(bound);
    const posed = dispatchMutatorFromUI(
      'mutator.animate.poseBone',
      { object: armature, bone: 'Bone0', rotation: [0, 0, 30] },
      'pose',
    );
    expect(posed.ok, JSON.stringify(posed)).toBe(true);
    const s0 = useDagStore.getState().state;
    const handLayer = poseLayerChain(graph(s0), armature).layers[0];
    const { state } = baked(s0, {
      object: armature,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId: freeBakedLayerId(s0, armature),
    });
    const chain = poseLayerChain(graph(state), armature);
    expect(chain.layers[0], 'the hand-pose layer still feeds the Object').toBe(handLayer);
    let worst = 0;
    let handMoved = 0;
    for (let f = 0; f <= 24; f += 3) {
      const before = deformAt(s0, f / 24).out;
      const after = deformAt(state, f / 24).out;
      const unposed = deformAt(bound, f / 24).out;
      before.forEach((c, i) => {
        worst = Math.max(worst, Math.abs(after[i] - c));
        handMoved = Math.max(handMoved, Math.abs(unposed[i] - c));
      });
    }
    expect(handMoved, 'control: the hand-pose moves the bar').toBeGreaterThan(0.1);
    expect(worst, 'baked + hand-pose = live + hand-pose').toBeLessThan(TOL);
  });

  it('one undo takes the bake back: the retarget drives the character again', async () => {
    const { state: s0, armature, retarget } = await boundBar();
    const result = bakePose(s0, {
      object: armature,
      poses: { kind: 'every' },
      interpolation: 'linear',
      layerId: freeBakedLayerId(s0, armature),
    });
    if (!result.ok) throw new Error(result.reason);
    useDagStore.getState().hydrate(s0);
    useDagStore.getState().dispatchAtomic([...result.ops], 'user');
    expect(poseLayerChain(graph(useDagStore.getState().state), armature).source?.node).not.toBe(
      retarget,
    );
    useDagStore.getState().undo();
    const back = useDagStore.getState().state;
    expect(poseLayerChain(graph(back), armature).source).toEqual({
      node: retarget,
      socket: 'posed',
    });
    expect(back.nodes[freeBakedLayerId(s0, armature)]).toBeUndefined();
  });
});

describe('#1215 — which poses, and what a bake refuses', () => {
  /** A wire whose range carries `count` evenly spaced times, both ends included (#1456). */
  const wire = (start: number, end: number, count: number): PosedSkeletonValue => ({
    kind: 'PosedSkeleton',
    skeleton: { kind: 'Skeleton', bones: [] },
    sample: () => [],
    clip: {
      start,
      end,
      times: Array.from({ length: count }, (_, i) => start + (i * (end - start)) / (count - 1)),
    },
  });

  it('every Nth pose keeps the last, as Houdini’s thinning does', () => {
    const got = bakeTimes(wire(0, 1, 25), { kind: 'nth', n: 5 });
    expect(got.ok && got.times.map((t) => Math.round(t * 24))).toEqual([0, 5, 10, 15, 20, 24]);
  });

  it('a range that does not start at 0 keys from its start', () => {
    const got = bakeTimes(wire(1, 2, 3), { kind: 'every' });
    expect(got.ok && got.times).toEqual([1, 1.5, 2]);
  });

  it('chosen poses: sorted, each once', () => {
    const got = bakeTimes(wire(0, 1, 25), { kind: 'times', times: [0.5, 0, 0.5] });
    expect(got.ok && got.times).toEqual([0, 0.5]);
  });

  it('each baked quaternion is on the previous key’s side of the sphere (Blender’s make_compatible)', () => {
    // A wire that hands back the same turn with its sign flipped every other pose: q and -q are one
    // rotation, and a key curve alternating between them would read as a spin through 360°.
    const half = Math.SQRT1_2;
    const flipping: PosedSkeletonValue = {
      kind: 'PosedSkeleton',
      skeleton: { kind: 'Skeleton', bones: [{ name: 'b' } as never] },
      sample: (t) => {
        const s = Math.round(t * 2) % 2 === 0 ? 1 : -1;
        return [
          {
            name: 'b',
            position: [0, 0, 0],
            quaternion: [0, 0, s * half, s * half],
            scale: [1, 1, 1],
          },
        ];
      },
    };
    const params = bakedLayerParams(flipping, [0, 0.5, 1], 'linear');
    const q = params.channels
      .find((c) => c.component === 'quaternion')!
      .keyframes.map(
        (k) => (k.value as number[]).map((c) => c + 0), // -0 is +0 here
      );
    expect(q).toEqual([
      [0, 0, half, half],
      [0, 0, half, half],
      [0, 0, half, half],
    ]);
  });

  it('a motion with no range cannot give its poses; a negative time is refused', () => {
    const rest: PosedSkeletonValue = { ...wire(0, 1, 1), clip: undefined };
    expect(bakeTimes(rest, { kind: 'every' }).ok).toBe(false);
    expect(bakeTimes(rest, { kind: 'times', times: [-1] }).ok).toBe(false);
  });

  it('refuses a chain already standing on its keys, a layer not in the chain, and a taken id', async () => {
    const { state, armature } = await bar();
    const base = {
      object: armature,
      poses: { kind: 'every' } as const,
      interpolation: 'linear' as const,
    };
    const onKeys = bakePose(state, { ...base, layerId: 'x' });
    expect(!onKeys.ok && onKeys.reason).toMatch(/plays keys already/);
    const stranger = bakePose(state, { ...base, at: 'nope', layerId: 'x' });
    expect(!stranger.ok && stranger.reason).toMatch(/not a pose layer/);
    const taken = bakePose(state, {
      ...base,
      at: poseLayerChain(graph(state), armature).base!,
      layerId: armature,
    });
    expect(!taken.ok && taken.reason).toMatch(/is taken/);
  });
});

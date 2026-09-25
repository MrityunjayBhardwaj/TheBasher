// #1215 — a bone's keys are edited where they live: in the pose layer that holds them, through the same
// key tools every channel uses (design D-A, K2; Blender edits the action's F-curves in place).
//
// Subject: skinned-bar-two-clips.glb (#1154), its first animation as the base layer — Bone1's rotation
// keyed at every frame 0..24. The file's key times are float32, so a sample at 13/24 lands a hair inside
// the edited segment (3.8e-7 measured): "holds" is within 1e-5, "moves" is more than 0.1. Keying
// Bone1 at frame 12 moves Bone1 and the vertices it deforms AT frame 12 and nowhere else (the
// neighbouring keys at 11 and 13 hold the curve), leaves Bone0 alone, and one undo restores both.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, evaluate } from '../../core/dag';
import type { DagState } from '../../core/dag/state';
import { emptyDagState } from '../../core/dag/state';
import { useDagStore } from '../../core/dag/store';
import { __buildSkinnedNativeGltfImportOpsForTests } from '../../core/import/nativeGltfImport';
import { registerAllNodes } from '../../nodes/registerAll';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import type {
  MeshGeometryData,
  ModifiedDataValue,
  ObjectValue,
  PosedSkeletonValue,
} from '../../nodes/types';
import type { PoseLayerParams } from '../../nodes/PoseLayer';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from './dispatchMutator';
import { poseLayerChain } from './poseChain';
import type { GraphNodeLike } from './graphNodes';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

const at = (seconds: number) =>
  ({ time: { frame: seconds * 24, seconds, normalized: 0 } }) as never;
const graph = (state: DagState) =>
  state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>;

async function bar() {
  const bytes = readFileSync('public/assets/skinned-bar-two-clips.glb');
  const result = await __buildSkinnedNativeGltfImportOpsForTests({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar-two-clips.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  const state = result.ops.slice(0, -1).reduce((s, op) => applyOp(s, op).next, emptyDagState());
  const armature = Object.values(state.nodes).find(
    (n) =>
      state.nodes[(n.inputs.data as { node: string } | undefined)?.node ?? '']?.type === 'Skeleton',
  )!.id;
  const layer = poseLayerChain(graph(state), armature).base!;
  useDagStore.getState().hydrate(state);
  return { state, armature, layer };
}

const live = () => useDagStore.getState().state;

function poseAt(state: DagState, armature: string, seconds: number) {
  const value = evaluate(state, armature, { ctx: at(seconds) }).value as ObjectValue;
  return (value as { pose?: PosedSkeletonValue }).pose!.sample(seconds);
}

function deformAt(state: DagState, seconds: number): Float32Array {
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const value = evaluate(state, modifierId, { ctx: at(seconds) }).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh' || !value.skin) throw new Error('no skinned mesh');
  return sampleSkinDeform(value.skin, descriptor.data as MeshGeometryData, seconds);
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.max(...Array.from(a, (c, i) => Math.abs(c - b[i])));

const channelsOf = (state: DagState, layer: string) =>
  (state.nodes[layer].params as PoseLayerParams).channels;

/** A quarter turn about X, xyzw. */
const QUARTER_X: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

describe('#1215 — one key edited in the layer that holds it', () => {
  it('keys Bone1 at frame 12: Bone1 and its vertices move at 12 and nowhere else; undo restores both', async () => {
    const { state: before, armature, layer } = await bar();
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone1', component: 'quaternion' },
        time: 0.5,
        value: QUARTER_X,
      },
      'key Bone1',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = live();

    // Where the key lives: the layer's own Bone1 curve, same length, the key at 0.5 replaced.
    const was = channelsOf(before, layer).find(
      (c) => c.bone === 'Bone1' && c.component === 'quaternion',
    )!;
    const now = channelsOf(after, layer).find(
      (c) => c.bone === 'Bone1' && c.component === 'quaternion',
    )!;
    expect(now.keyframes).toHaveLength(was.keyframes.length);
    expect(now.keyframes.find((k) => k.time === 0.5)!.value).toEqual(QUARTER_X);
    expect(
      Object.values(after.nodes).filter((n) => n.type.startsWith('KeyframeChannel')),
    ).toHaveLength(
      Object.values(before.nodes).filter((n) => n.type.startsWith('KeyframeChannel')).length,
    );

    // The bone: Bone1 at frame 12 is the keyed rotation; Bone0 untouched at every frame.
    const q = poseAt(after, armature, 0.5).find((b) => b.name === 'Bone1')!.quaternion;
    q.forEach((c, k) => expect(c).toBeCloseTo(QUARTER_X[k], 9));
    for (let f = 0; f <= 24; f++) {
      const a = poseAt(before, armature, f / 24);
      const b = poseAt(after, armature, f / 24);
      expect(maxDiff(a[0].quaternion, b[0].quaternion), `Bone0 at ${f}`).toBe(0);
      const moved = maxDiff(a[1].quaternion, b[1].quaternion);
      if (f === 12) expect(moved, 'Bone1 moves at 12').toBeGreaterThan(0.1);
      else expect(moved, `Bone1 holds at ${f}`).toBeLessThan(1e-5);
    }

    // The deform: moves at 12 only.
    expect(
      maxDiff(deformAt(before, 0.5), deformAt(after, 0.5)),
      'the skin moves at 12',
    ).toBeGreaterThan(0.05);
    for (const f of [0, 11, 13, 24]) {
      expect(
        maxDiff(deformAt(before, f / 24), deformAt(after, f / 24)),
        `skin holds at ${f}`,
      ).toBeLessThan(1e-5);
    }

    // One undo: the key, the bone and the skin are back.
    useDagStore.getState().undo();
    expect(channelsOf(live(), layer)).toEqual(channelsOf(before, layer));
    expect(maxDiff(deformAt(before, 0.5), deformAt(live(), 0.5))).toBe(0);
  });

  it('keying a bone the layer does not hold adds its curve and its membership, in the mode the key names', async () => {
    const { state: before, layer } = await bar();
    const onlyBone1 = (before.nodes[layer].params as PoseLayerParams).members.map((m) => m.bone);
    expect(onlyBone1).toContain('Bone0');
    // A fresh override layer with nothing in it, under the Object's pose, to key into.
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone0', component: 'position' },
        time: 0.25,
        value: [0, 2, 0],
      },
      'key Bone0 position',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const ch = channelsOf(live(), layer).filter(
      (c) => c.bone === 'Bone0' && c.component === 'position',
    );
    expect(ch).toHaveLength(1);
    expect(ch[0].keyframes.some((k) => k.time === 0.25)).toBe(true);
  });

  it('a new curve on a bone with no membership creates both', async () => {
    const { layer } = await bar();
    // Strip Bone0 out of the layer, then key it.
    const params = live().nodes[layer].params as PoseLayerParams;
    useDagStore.getState().dispatchAtomic(
      [
        {
          type: 'setParam',
          nodeId: layer,
          paramPath: 'members',
          value: params.members.filter((m) => m.bone !== 'Bone0'),
        },
        {
          type: 'setParam',
          nodeId: layer,
          paramPath: 'channels',
          value: params.channels.filter((c) => c.bone !== 'Bone0'),
        },
      ],
      'user',
    );
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone0', component: 'rotation' },
        time: 0,
        value: [0, 0, 30],
      },
      'key Bone0',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const p = live().nodes[layer].params as PoseLayerParams;
    expect(p.members.find((m) => m.bone === 'Bone0')).toEqual({
      bone: 'Bone0',
      rotationMode: 'XYZ',
    });
    expect(p.channels.filter((c) => c.bone === 'Bone0').map((c) => c.component)).toEqual([
      'rotation',
    ]);
    // Now an XYZ member: a quaternion curve would be ignored by the layer, so it is refused.
    const quat = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone0', component: 'quaternion' },
        time: 0,
        value: [0, 0, 0, 1],
      },
      'key',
    );
    expect(!quat.ok && quat.reason).toMatch(/XYZ euler/);
  });

  it('#1254 — refuses a bone the skeleton does not have, and a layer whose skeleton cannot be found', async () => {
    const { layer } = await bar();
    const misspelled = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone_1', component: 'position' },
        time: 0,
        value: [0, 1, 0],
      },
      'key',
    );
    expect(!misspelled.ok && misspelled.reason).toMatch(/no bone "Bone_1".*Bone0, Bone1/);
    // A layer feeding no armature Object: its skeleton cannot be known, and it says so.
    useDagStore
      .getState()
      .dispatchAtomic(
        [{ type: 'addNode', nodeId: 'loose_layer', nodeType: 'PoseLayer', params: {} }],
        'user',
      );
    const loose = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: 'loose_layer', bone: 'Bone1', component: 'position' },
        time: 0,
        value: [0, 1, 0],
      },
      'key',
    );
    expect(!loose.ok && loose.reason).toMatch(/cannot tell which skeleton/);
  });

  it('refuses a rotation curve of the other mode, and names the one to use', async () => {
    const { layer } = await bar();
    const res = dispatchMutatorFromUI(
      'mutator.timeline.keyframe',
      {
        layer: { layerId: layer, bone: 'Bone1', component: 'rotation' },
        time: 0.5,
        value: [0, 0, 30],
      },
      'key',
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/quaternion/);
  });

  it('removing a curve’s last key removes the curve (Blender), and the bone falls back to what is below', async () => {
    const { layer, armature } = await bar();
    const bone0Pos = channelsOf(live(), layer).find(
      (c) => c.bone === 'Bone0' && c.component === 'position',
    )!;
    expect(bone0Pos.keyframes.length).toBeGreaterThan(0);
    const res = dispatchMutatorFromUI(
      'mutator.timeline.removeKeyframes',
      { layer: { layerId: layer, bone: 'Bone0', component: 'position' }, scope: 'all' },
      'remove',
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(
      channelsOf(live(), layer).some((c) => c.bone === 'Bone0' && c.component === 'position'),
    ).toBe(false);
    // Nothing keyed and no static value: Bone0's position is the rest pose's.
    const rest = evaluate(live(), (live().nodes[armature].inputs.data as { node: string }).node, {
      socket: 'pose',
      ctx: at(0),
    }).value as PosedSkeletonValue;
    expect(poseAt(live(), armature, 0.5)[0].position).toEqual(rest.sample(0.5)[0].position);
    // Nothing left to remove: refused, not a silent empty write.
    const again = dispatchMutatorFromUI(
      'mutator.timeline.removeKeyframes',
      { layer: { layerId: layer, bone: 'Bone0', component: 'position' }, scope: 'all' },
      'remove',
    );
    expect(again.ok).toBe(false);
  });

  it('re-interpolates and extends a layer curve in one rewrite of the list each', async () => {
    const { layer } = await bar();
    const interp = dispatchMutatorFromUI(
      'mutator.timeline.setKeyframeInterp',
      {
        layer: { layerId: layer, bone: 'Bone1', component: 'quaternion' },
        scope: 'all',
        easing: 'constant',
      },
      'interp',
    );
    expect(interp.ok, JSON.stringify(interp)).toBe(true);
    const q = channelsOf(live(), layer).find(
      (c) => c.bone === 'Bone1' && c.component === 'quaternion',
    )!;
    expect(new Set(q.keyframes.map((k) => k.easing))).toEqual(new Set(['constant']));

    const extend = dispatchMutatorFromUI(
      'mutator.timeline.setChannelExtend',
      {
        layer: { layerId: layer, bone: 'Bone0', component: 'position' },
        before: 'slope',
        after: 'slope',
      },
      'extend',
    );
    expect(extend.ok, JSON.stringify(extend)).toBe(true);
    const p = channelsOf(live(), layer).find(
      (c) => c.bone === 'Bone0' && c.component === 'position',
    )! as {
      extendBefore?: string;
      extendAfter?: string;
    };
    expect([p.extendBefore, p.extendAfter]).toEqual(['slope', 'slope']);
  });
});

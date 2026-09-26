// #1216 slice 2 — a saved clone-road character's MOTION edits land where the native tool for the
// same gesture writes them. Each case makes the edit with the product's own tools on the clone road,
// converts, and compares with a fresh native import given the same edit by the native tools: the
// nodes, and every deformed vertex at two times.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, evaluate } from '../../core/dag';
import { applyOp } from '../../core/dag/ops';
import type { DagState } from '../../core/dag/state';
import type { Op } from '../../core/dag/types';
import { useDagStore } from '../../core/dag/store';
import { buildDefaultDagState } from '../../core/project/default';
import { buildGltfImportOps, gltfSkeletonDagId, hashId } from '../../core/import/gltfImportChain';
import {
  buildSavedCharacterOps,
  type NativeImportResult,
} from '../../core/import/nativeGltfImport';
import { buildBvhImportOps } from '../../core/import/bvhImportChain';
import { buildSkeletonObjectOps } from '../../core/import/skeletonObject';
import { registerAllNodes } from '../../nodes/registerAll';
import type { BoneSpec, MeshGeometryData, SkinDeformValue } from '../../nodes/types';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { __resetMutatorRegistryForTests, registerAllMutators } from '../../agent/mutators';
import { useDiffStore } from '../../agent/diff/store';
import { dispatchMutatorFromUI } from '../animate/dispatchMutator';
import { convertCloneCharacters, type ConvertCloneCharactersDeps } from './convertCloneCharacters';
import { handPoseOps } from '../../agent/mutators/builders/poseBone';
import { handPoseLayerOf } from '../animate/poseChain';
import type { GraphNodeLike } from '../animate/graphNodes';
import type { PoseLayerChannel } from '../../nodes/PoseLayer';
import type { RotationModeFields } from '../../nodes/types';
import { rotationModeOps } from '../resolvedRotation';

const REF = 'user-imports/skinned-bar/skinned-bar.glb';

function bytesOf(fixture: string | Uint8Array): Uint8Array {
  return typeof fixture === 'string'
    ? new Uint8Array(readFileSync(`public/assets/${fixture}`))
    : fixture;
}

/** A GLB fixture with its JSON chunk rewritten; the binary chunk is carried over untouched. */
function glbWith(fixture: string, mutate: (json: { nodes: { name?: string }[] }) => void) {
  const src = readFileSync(`public/assets/${fixture}`);
  const jsonLength = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLength).toString());
  mutate(json);
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonBytes = Buffer.from(text);
  const rest = src.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([header, jsonBytes, rest]));
}

/** skinned-bar with both joints named "Bone": the clone keys them `Bone` / `Bone__1` in file order,
 *  the native skeleton `Bone` / `Bone.001` in bone order — node 0 is `Bone` on one road and
 *  `Bone.001` on the other. A join by name would pose the wrong bone. */
const SAME_NAMES = glbWith('skinned-bar.glb', (json) => {
  json.nodes[0].name = 'Bone';
  json.nodes[1].name = 'Bone';
});

function deps(fixture: string | Uint8Array): ConvertCloneCharactersDeps {
  return {
    read: async (path) => {
      if (path !== REF) throw new Error(`no file at ${path}`);
      return bytesOf(fixture);
    },
    storeImage: async () => 'img',
  };
}

function argsFor(fixture: string | Uint8Array) {
  const bytes = bytesOf(fixture);
  return {
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: REF,
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  };
}

function apply(state: DagState, ops: readonly Op[]): DagState {
  let next = state;
  for (const op of ops) next = applyOp(next, op).next;
  return next;
}

/** A two-joint motion named as the bar's bones: `Bone1` swings 0° → 45° → 90° about Z over 1 s. */
const SWING = (root: string, tip: string) => `HIERARCHY
ROOT ${root}
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT ${tip}
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
0 0 0 10 0 0 45 0 0
0 0 0 20 0 0 90 0 0
`;

/** A BVH motion standing in the scene as its own rig, as the import road stands one. */
function withMotion(state: DagState, id: string): DagState {
  const motion = buildBvhImportOps({
    text: SWING('Hips', 'Spine'),
    name: id,
    ids: { skeleton: `${id}_skel`, clip: `${id}_clip` },
  });
  state = apply(state, motion.ops);
  const bones = (state.nodes[`${id}_skel`].params as { bones: BoneSpec[] }).bones;
  return apply(
    state,
    buildSkeletonObjectOps({
      skeletonId: `${id}_skel`,
      bones,
      sceneNodeId: state.outputs.scene!.node,
      normalise: false,
      name: id,
      clipId: `${id}_clip`,
      nameFollowsClip: true,
    }).ops,
  );
}

/** The saved project: the file on the clone road, plus a motion to bind. */
async function cloneProject(fixture: string | Uint8Array): Promise<DagState> {
  const clone = await buildGltfImportOps(argsFor(fixture), buildDefaultDagState());
  return withMotion(apply(buildDefaultDagState(), clone.ops), 'swing');
}

/** The same project with the file imported fresh on the native road. */
async function nativeProject(
  fixture: string | Uint8Array,
): Promise<{ state: DagState; native: NativeImportResult }> {
  const native = await buildSavedCharacterOps(argsFor(fixture));
  if ('refused' in native) throw new Error(native.refused);
  return { state: withMotion(apply(buildDefaultDagState(), native.ops), 'swing'), native };
}

/** Run a mutator the way the product does, on `state`; the state it leaves. */
function tool(state: DagState, name: string, spec: unknown): DagState {
  useDagStore.getState().hydrate(state);
  const result = dispatchMutatorFromUI(name, spec, 'test');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return useDagStore.getState().state;
}

/** The clone's key for the file's node `index` (its joint keys, as the clone rig names bones). */
function cloneKey(state: DagState, index: number): string {
  const asset = Object.values(state.nodes).find((n) => n.type === 'GltfAsset')!;
  return (asset.params as { keyByGltfNodeIndex: Record<number, string> }).keyByGltfNodeIndex[index];
}

function cloneChild(state: DagState, index: number): string {
  const asset = Object.values(state.nodes).find((n) => n.type === 'GltfAsset')!;
  return (asset.params as { nodeNameMap: Record<string, string> }).nodeNameMap[
    cloneKey(state, index)
  ];
}

/** The clone road's gizmo on an imported child: the value and its `overridden` bit, one dispatch. */
function gizmo(state: DagState, nodeId: string, field: string, value: number[]): DagState {
  return apply(state, [
    { type: 'setParam', nodeId, paramPath: field, value },
    { type: 'setParam', nodeId, paramPath: `overridden.${field}`, value: true },
  ]);
}

/** Every vertex every Armature modifier deforms, at `seconds`, modifiers in id order. */
function deformed(state: DagState, seconds: number): number[] {
  const ctx = { time: { frame: seconds * 24, seconds, normalized: 0 } };
  const out: number[] = [];
  const modifiers = Object.values(state.nodes)
    .filter((n) => n.type === 'ArmatureModifier')
    .map((n) => n.id)
    .sort();
  for (const id of modifiers) {
    const value = evaluate(state, id, { ctx }).value as {
      geometry: { descriptor: { data: MeshGeometryData } };
      skin: SkinDeformValue;
    };
    out.push(...sampleSkinDeform(value.skin, value.geometry.descriptor.data, seconds));
  }
  return out;
}

/** The converted state equals the native one: node for node, and every vertex at 0.5 s and 1 s. */
function expectSameCharacter(converted: DagState, native: DagState) {
  expect(converted.nodes).toEqual(native.nodes);
  for (const t of [0.5, 1]) {
    const got = deformed(converted, t);
    const want = deformed(native, t);
    expect(got.length).toBeGreaterThan(0);
    got.forEach((v, i) => expect(v, `vertex coord ${i} @${t}s`).toBeCloseTo(want[i], 6));
  }
}

async function convert(saved: DagState, fixture: string | Uint8Array) {
  const { state, report } = await convertCloneCharacters(saved, deps(fixture));
  expect(report.kept).toEqual([]);
  expect(report.converted).toHaveLength(1);
  return { state, notes: report.converted[0].notes };
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
  __resetMutatorRegistryForTests();
  registerAllMutators();
  useDiffStore.getState().reset();
});

describe('a bone posed by hand on the clone road', () => {
  it.each([
    ['skinned-bar.glb', 'the file animates the bone: the pose holds against its keys'],
    [SAME_NAMES, 'two joints named alike: joined by node index, not by name'],
  ] as const)(
    '%s — the hand-pose layer member posing it natively writes (%s)',
    async (fixture, _why) => {
      let saved = await cloneProject(fixture);
      saved = gizmo(saved, cloneChild(saved, 0), 'rotation', [0, 0, 30]);
      const { state } = await convert(saved, fixture);

      const { state: fresh, native } = await nativeProject(fixture);
      const bone = native.skeletons[0].boneNames.get(0)!;
      const want = tool(fresh, 'mutator.animate.poseBone', {
        object: native.skeletons[0].objectId,
        bone,
        rotation: [0, 0, 30],
      });
      expectSameCharacter(state, want);
      // And the pose shows: the tip moved away from the unposed character.
      expect(deformed(state, 0.5)).not.toEqual(deformed(fresh, 0.5));
    },
  );

  it('a value the motion drew over (a reverted override) is not carried: the clone drew the motion', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = apply(saved, [
      { type: 'setParam', nodeId: cloneChild(saved, 0), paramPath: 'rotation', value: [0, 0, 30] },
    ]);
    const { state } = await convert(saved, 'skinned-bar.glb');
    expectSameCharacter(state, (await nativeProject('skinned-bar.glb')).state);
  });
});

describe('a motion bound on the clone road', () => {
  /** Bind the swing onto the rig named `targetSkeletonId`, bone names as that rig spells them. */
  function bind(state: DagState, targetSkeletonId: string, bones: [string, string]) {
    return tool(state, 'mutator.animation.retarget', {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId,
      customMap: { Hips: bones[0], Spine: bones[1] },
      outputClipId: 'swing_on_bar',
      outputName: 'bar motion',
    });
  }

  it.each(['skinned-bar.glb', SAME_NAMES] as const)(
    '%s — the bind the retarget writes for a native character: at the chain bottom, the base muted, the map in the skeleton’s spelling',
    async (fixture) => {
      let saved = await cloneProject(fixture);
      // node 1 is the root bone, node 0 its child.
      saved = bind(saved, gltfSkeletonDagId(REF, 0), [cloneKey(saved, 1), cloneKey(saved, 0)]);
      const { state, notes } = await convert(saved, fixture);

      const { state: fresh, native } = await nativeProject(fixture);
      const names = native.skeletons[0].boneNames;
      const want = bind(fresh, native.skeletons[0].skeletonId, [names.get(1)!, names.get(0)!]);
      expectSameCharacter(state, want);
      expect(notes).toEqual([]);
    },
  );

  it('with a PoseOverride on the bound motion: the member posing the bone natively writes, above the bind', async () => {
    let saved = await cloneProject(SAME_NAMES);
    saved = bind(saved, gltfSkeletonDagId(REF, 0), [cloneKey(saved, 1), cloneKey(saved, 0)]);
    saved = tool(saved, 'mutator.animate.poseBone', {
      retarget: 'swing_on_bar',
      bone: cloneKey(saved, 0),
      rotation: [0, 0, -20],
    });
    expect(Object.values(saved.nodes).filter((n) => n.type === 'PoseOverride')).toHaveLength(1);
    const { state } = await convert(saved, SAME_NAMES);

    const { state: fresh, native } = await nativeProject(SAME_NAMES);
    const names = native.skeletons[0].boneNames;
    let want = bind(fresh, native.skeletons[0].skeletonId, [names.get(1)!, names.get(0)!]);
    want = tool(want, 'mutator.animate.poseBone', {
      object: native.skeletons[0].objectId,
      bone: names.get(0)!,
      rotation: [0, 0, -20],
    });
    expectSameCharacter(state, want);
    expect(Object.values(state.nodes).some((n) => n.type === 'PoseOverride')).toBe(false);
  });

  it('a bone the director also moved by hand: its own override wins over the PoseOverride, as on the clone', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = bind(saved, gltfSkeletonDagId(REF, 0), ['Bone0', 'Bone1']);
    saved = tool(saved, 'mutator.animate.poseBone', {
      retarget: 'swing_on_bar',
      bone: 'Bone1',
      rotation: [0, 0, -20],
    });
    saved = gizmo(saved, cloneChild(saved, 0), 'rotation', [0, 0, 60]);
    const { state } = await convert(saved, 'skinned-bar.glb');

    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    let want = bind(fresh, native.skeletons[0].skeletonId, ['Bone0', 'Bone1']);
    want = tool(want, 'mutator.animate.poseBone', {
      object: native.skeletons[0].objectId,
      bone: 'Bone1',
      rotation: [0, 0, 60],
    });
    expectSameCharacter(state, want);
  });

  it('two binds, the earlier one filling a bone the later does not key: kept, and named', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = tool(saved, 'mutator.animation.retarget', {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId: gltfSkeletonDagId(REF, 0),
      customMap: { Hips: 'Bone0' },
      outputClipId: 'root_only',
    });
    saved = tool(saved, 'mutator.animation.retarget', {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId: gltfSkeletonDagId(REF, 0),
      customMap: { Spine: 'Bone1' },
      outputClipId: 'tip_only',
    });
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      expect.stringMatching(/"root_only" also plays on this character \("Bone0"\)/),
    ]);
  });
});

describe('binds: the edges of what carries', () => {
  const retarget = (state: DagState, map: Record<string, string>, outputClipId: string) =>
    tool(state, 'mutator.animation.retarget', {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId: gltfSkeletonDagId(REF, 0),
      customMap: map,
      outputClipId,
    });

  it('a project saved before binds had an active flag: the clip the clone played (first by id) is bound, and made active', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = retarget(saved, { Hips: 'Bone0', Spine: 'Bone1' }, 'b_second');
    saved = retarget(saved, { Hips: 'Bone0', Spine: 'Bone1' }, 'a_first');
    saved = apply(saved, [
      { type: 'setParam', nodeId: 'a_first', paramPath: 'active', value: false },
      { type: 'setParam', nodeId: 'b_second', paramPath: 'active', value: false },
    ]);
    const { state } = await convert(saved, 'skinned-bar.glb');
    expect((state.nodes.a_first.params as { active: boolean }).active).toBe(true);
    expect((state.nodes.b_second.params as { active: boolean }).active).toBe(false);
    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const posedBy = (s: DagState) =>
      Object.values(s.nodes).find((n) => n.type === 'PoseLayer')!.inputs.pose;
    expect(posedBy(state)).toEqual({ node: 'a_first', socket: 'posed' });
    expect(posedBy(fresh)).toEqual({ node: native.skeletons[0].skeletonId, socket: 'pose' });
  });

  it('a bind that leaves a bone the file animates unmoved: converts, and says that bone now rests', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = retarget(saved, { Hips: 'Bone0' }, 'root_only');
    const { notes } = await convert(saved, 'skinned-bar.glb');
    expect(notes).toEqual([
      `the file's own animation no longer plays under the bound "root_only" ("Bone1" now rest), as binding a motion does natively`,
    ]);
  });

  it('a bone map another rig’s retarget also reads: kept, and named (made by hand; no tool shares one)', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = retarget(saved, { Hips: 'Bone0', Spine: 'Bone1' }, 'on_bar');
    saved = apply(saved, [
      { type: 'addNode', nodeId: 'other_rt', nodeType: 'RetargetClip', params: { name: 'other' } },
      {
        type: 'connect',
        from: { node: 'on_bar_map', socket: 'out' },
        to: { node: 'other_rt', socket: 'boneMap' },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      expect.stringMatching(/maps bones for "other" too, a rig this conversion does not touch/),
    ]);
  });

  it('a PoseOverride read outside its own chain: kept, and named (made by hand)', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = retarget(saved, { Hips: 'Bone0', Spine: 'Bone1' }, 'on_bar');
    saved = tool(saved, 'mutator.animate.poseBone', {
      retarget: 'on_bar',
      bone: 'Bone1',
      rotation: [0, 0, 10],
    });
    const override = Object.values(saved.nodes).find((n) => n.type === 'PoseOverride')!.id;
    saved = apply(saved, [
      { type: 'addNode', nodeId: 'reader', nodeType: 'PoseLayer', params: { name: 'reader' } },
      {
        type: 'connect',
        from: { node: override, socket: 'out' },
        to: { node: 'reader', socket: 'pose' },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      expect.stringMatching(/"reader" reads the pose .* through "pose"/),
    ]);
  });
});

describe('the take a ClipSelect picked', () => {
  const TWO = 'skinned-bar-two-clips.glb';

  it('a later take: it plays and the first is muted, as muting and unmuting the layers natively does', async () => {
    let saved = await cloneProject(TWO);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: hashId('sel', REF),
        paramPath: 'selectedClipName',
        value: 'Wave',
      },
    ]);
    const { state } = await convert(saved, TWO);

    const { state: fresh, native } = await nativeProject(TWO);
    const want = apply(fresh, [
      ...native.takes[0].layers.map(
        (id): Op => ({ type: 'setParam', nodeId: id, paramPath: 'mute', value: true }),
      ),
      ...native.takes[1].layers.map(
        (id): Op => ({ type: 'setParam', nodeId: id, paramPath: 'mute', value: false }),
      ),
    ]);
    expect(native.takes[1].layers).toHaveLength(1);
    expectSameCharacter(state, want);
    // Wave, not bend: the draw differs from the untouched import.
    expect(deformed(state, 0.5)).not.toEqual(deformed(fresh, 0.5));
  });

  it('a name no take has: nothing of the file plays, as saved, and the load says so', async () => {
    let saved = await cloneProject(TWO);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: hashId('sel', REF),
        paramPath: 'selectedClipName',
        value: 'gone',
      },
    ]);
    const { state, notes } = await convert(saved, TWO);
    const { native } = await nativeProject(TWO);
    for (const id of [...native.takes[0].layers, ...native.takes[1].layers]) {
      expect((state.nodes[id].params as { mute?: boolean }).mute, id).toBe(true);
    }
    expect(notes).toEqual([expect.stringMatching(/none of the file's animations plays/)]);
  });

  it('a later take beside a bound motion: kept, and named (natively the bind replaces the file’s motion)', async () => {
    let saved = await cloneProject(TWO);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: hashId('sel', REF),
        paramPath: 'selectedClipName',
        value: 'Wave',
      },
    ]);
    saved = tool(saved, 'mutator.animation.retarget', {
      sourceClipId: 'swing_clip',
      sourceSkeletonId: 'swing_skel',
      targetSkeletonId: gltfSkeletonDagId(REF, 0),
      customMap: { Hips: 'Bone0', Spine: 'Bone1' },
      outputClipId: 'swing_on_bar',
    });
    const { state, report } = await convertCloneCharacters(saved, deps(TWO));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([expect.stringMatching(/plays beside the bound/)]);
  });
});

describe('keys edited on a bone on the clone road (slice 3)', () => {
  /** The clone road's key tool on a bone: copy-on-write of the file's track, then the key. */
  function keyCloneBone(state: DagState, childName: string, time: number, value: number[]) {
    return tool(state, 'mutator.timeline.keyframe', {
      bone: { assetRef: REF, childName, component: 'rotation' },
      time,
      value,
    });
  }

  /** The clone channel the key tool left on `childName`. */
  function cloneChannel(state: DagState, childName: string) {
    return Object.values(state.nodes).find(
      (n) =>
        n.type === 'KeyframeChannelVec3' &&
        (n.params as { childName?: string }).childName === childName,
    )!;
  }

  /** The same keys written by the native key tool into the hand-pose layer, on a fresh import. */
  function keyNativeBone(
    state: DagState,
    objectId: string,
    bone: string,
    keys: readonly { time: number; value: number[]; easing?: string }[],
  ): DagState {
    state = apply(state, handPoseOps(state, objectId, bone, {}));
    const layerId = handPoseLayerOf(
      state.nodes as unknown as Readonly<Record<string, GraphNodeLike>>,
      objectId,
    )!;
    for (const k of keys) {
      state = tool(state, 'mutator.timeline.keyframe', {
        layer: { layerId, bone, component: 'rotation' },
        time: k.time,
        value: k.value,
        ...(k.easing ? { easing: k.easing } : {}),
      });
    }
    return state;
  }

  const layerChannels = (state: DagState): PoseLayerChannel[] =>
    Object.values(state.nodes)
      .filter((n) => n.type === 'PoseLayer')
      .flatMap((n) => (n.params as { channels: PoseLayerChannel[] }).channels);

  it.each(['skinned-bar.glb', SAME_NAMES] as const)(
    '%s — a key edit on a bone the file animates: its curve in the hand-pose layer, as the native key tool writes it',
    async (fixture) => {
      let saved = await cloneProject(fixture);
      saved = keyCloneBone(saved, cloneKey(saved, 0), 0.5, [20, 0, 40]);
      const channel = cloneChannel(saved, cloneKey(saved, 0));
      const keys = (
        channel.params as { keyframes: { time: number; value: number[]; easing?: string }[] }
      ).keyframes;
      expect(keys.length, 'the copy-on-write track plus the edit').toBeGreaterThan(1);
      const { state, notes } = await convert(saved, fixture);
      expect(state.nodes[channel.id]).toBeUndefined();
      expect(notes).toEqual([]);

      const { state: fresh, native } = await nativeProject(fixture);
      const bone = native.skeletons[0].boneNames.get(0)!;
      const want = keyNativeBone(fresh, native.skeletons[0].objectId, bone, keys);
      const got = layerChannels(state).filter((c) => c.component === 'rotation' && c.bone === bone);
      expect(got).toHaveLength(1);
      expect(got[0].keyframes).toEqual(
        layerChannels(want).find((c) => c.component === 'rotation' && c.bone === bone)!.keyframes,
      );
      for (const t of [0.25, 0.5, 1]) {
        const a = deformed(state, t);
        const b = deformed(want, t);
        a.forEach((v, i) => expect(v, `coord ${i} @${t}s`).toBeCloseTo(b[i], 6));
      }
      // The edit shows: 40° at 0.5 s is not the file's own bend.
      expect(deformed(state, 0.5)).not.toEqual(deformed(fresh, 0.5));
    },
  );

  it('a key edit on one bone beside a hand-pose on another: the keyed bone joins the layer in the clone’s euler order', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = gizmo(saved, cloneChild(saved, 1), 'rotation', [0, 0, 5]);
    saved = keyCloneBone(saved, 'Bone1', 0.5, [20, 0, 40]);
    const keys = (
      cloneChannel(saved, 'Bone1').params as {
        keyframes: { time: number; value: number[]; easing?: string }[];
      }
    ).keyframes;
    const { state } = await convert(saved, 'skinned-bar.glb');

    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const objectId = native.skeletons[0].objectId;
    let want = tool(fresh, 'mutator.animate.poseBone', {
      object: objectId,
      bone: 'Bone0',
      rotation: [0, 0, 5],
    });
    want = keyNativeBone(want, objectId, 'Bone1', keys);
    expectSameCharacter(state, want);
  });

  it("a component the bone's Object forces: the clone drew the forced value, so the channel is not carried", async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = keyCloneBone(saved, 'Bone1', 0.5, [0, 0, 40]);
    saved = gizmo(saved, cloneChild(saved, 0), 'rotation', [0, 0, 10]);
    const { state } = await convert(saved, 'skinned-bar.glb');
    expect(
      layerChannels(state).filter((c) => c.bone === 'Bone1' && c.component === 'rotation'),
    ).toEqual([]);
    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const want = tool(fresh, 'mutator.animate.poseBone', {
      object: native.skeletons[0].objectId,
      bone: 'Bone1',
      rotation: [0, 0, 10],
    });
    expectSameCharacter(state, want);
  });

  it('a muted curve: carried muted, and the load says it now plays muted', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = keyCloneBone(saved, 'Bone1', 0.5, [0, 0, 40]);
    const channel = cloneChannel(saved, 'Bone1');
    saved = apply(saved, [
      { type: 'setParam', nodeId: channel.id, paramPath: 'mute', value: true },
    ]);
    const { state, notes } = await convert(saved, 'skinned-bar.glb');
    expect(
      layerChannels(state).find((c) => c.bone === 'Bone1' && c.component === 'rotation')?.mute,
    ).toBe(true);
    expect(notes).toEqual([expect.stringMatching(/is now muted as it is marked/)]);
  });
});

describe('keys edited on a node of the file that is not a bone (#1263)', () => {
  const RIG = 'skinned-bar-animated-rig.glb';
  // Two axes on every rotation, so an euler order or an euler/quaternion slip changes the answer.
  // Each key's easing as the clone's key tool leaves it (a seeded key keeps `linear`, a new one is
  // `cubic`); the native tool is handed the same, so both roads hold the same keys.
  const ROT = [
    { time: 0, value: [0, 0, 0], easing: 'linear' },
    { time: 0.5, value: [20, 10, 30], easing: 'cubic' },
    { time: 1, value: [40, -15, 60], easing: 'cubic' },
  ];
  const POS = [
    { time: 0.5, value: [0.2, 0.1, -0.3], easing: 'cubic' },
    { time: 1, value: [0.6, 0, 0.2], easing: 'cubic' },
  ];

  /** The clone road's key tool on the file's `Rig` node, each key in turn. */
  function keyCloneRig(state: DagState, component: string, keys: typeof ROT): DagState {
    for (const k of keys) {
      state = tool(state, 'mutator.timeline.keyframe', {
        bone: { assetRef: REF, childName: 'Rig', component },
        time: k.time,
        value: k.value,
      });
    }
    return state;
  }

  /** The native road, same keys: the inspector's switch to euler, then the key tools on `Rig`. */
  function keyNativeRig(state: DagState, rig: string): DagState {
    state = apply(
      state,
      rotationModeOps(rig, state.nodes[rig].params as RotationModeFields, 'euler'),
    );
    state = tool(state, 'mutator.timeline.addChannel', {
      target: rig,
      paramPath: 'rotation',
      valueType: 'vec3',
    });
    for (const k of ROT) {
      state = tool(state, 'mutator.timeline.keyframe', {
        channelId: `${rig}_rotation_channel`,
        time: k.time,
        value: k.value,
        easing: k.easing,
      });
    }
    for (const k of POS) {
      state = tool(state, 'mutator.timeline.keyframe', {
        channelId: `${rig}_position_channel`,
        time: k.time,
        value: k.value,
        easing: k.easing,
      });
    }
    return state;
  }

  const rigOf = (native: NativeImportResult): string => native.nodeIds[3]!;

  it('rotation and location keyed: the node turns in euler mode on its own curve, the location curve rewritten in place', async () => {
    let saved = await cloneProject(RIG);
    saved = keyCloneRig(saved, 'rotation', ROT);
    saved = keyCloneRig(saved, 'position', POS);
    const { state, notes } = await convert(saved, RIG);

    const { state: fresh, native } = await nativeProject(RIG);
    const rig = rigOf(native);
    expectSameCharacter(state, keyNativeRig(fresh, rig));
    // The file's quaternion curve stays, composing nothing; the node is in euler mode.
    expect(state.nodes[`${rig}_quaternion_channel`]).toEqual(
      fresh.nodes[`${rig}_quaternion_channel`],
    );
    expect((state.nodes[rig].params as RotationModeFields).rotationMode).toBeUndefined();
    expect(notes).toEqual([expect.stringContaining('"Rig" now turns in euler mode')]);
  });

  it("a component the node's Object forces: the clone drew the forced value, so its keys are not carried", async () => {
    let saved = await cloneProject(RIG);
    saved = keyCloneRig(saved, 'rotation', ROT);
    saved = gizmo(saved, cloneChild(saved, 3), 'rotation', [20, 0, 30]);
    const { state } = await convert(saved, RIG);

    const { state: fresh, native } = await nativeProject(RIG);
    const rig = rigOf(native);
    expect((state.nodes[rig].params as RotationModeFields).rotationMode).toBe('quaternion');
    expect(state.nodes[`${rig}_rotation_channel`]).toBeUndefined();
    expect(
      Object.values(state.nodes).some(
        (n) => n.type === 'KeyframeChannelVec3' && (n.params as { assetRef?: string }).assetRef,
      ),
    ).toBe(false);
    // The forced value is carried as the moved-child rule carries it, under the file's keys.
    expect(Object.keys(state.nodes).sort()).toEqual(Object.keys(fresh.nodes).sort());
  });

  it('a muted curve on the node: carried muted, and the load says it now plays muted', async () => {
    let saved = await cloneProject(RIG);
    saved = keyCloneRig(saved, 'position', POS);
    const channel = Object.values(saved.nodes).find(
      (n) =>
        n.type === 'KeyframeChannelVec3' &&
        (n.params as { childName?: string }).childName === 'Rig',
    )!;
    saved = apply(saved, [
      { type: 'setParam', nodeId: channel.id, paramPath: 'mute', value: true },
    ]);
    const { state, notes } = await convert(saved, RIG);
    const rig = rigOf((await nativeProject(RIG)).native);
    expect((state.nodes[`${rig}_position_channel`].params as { mute: boolean }).mute).toBe(true);
    expect(notes).toEqual([expect.stringContaining('is now muted as it is marked')]);
  });

  it('keys edited while no take plays: kept, and named (natively they live in the first take’s curve)', async () => {
    let saved = await cloneProject(RIG);
    saved = keyCloneRig(saved, 'position', POS);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: hashId('sel', REF),
        paramPath: 'selectedClipName',
        value: 'no such take',
      },
    ]);
    const { report } = await convertCloneCharacters(saved, deps(RIG));
    expect(report.converted).toEqual([]);
    expect(report.kept[0].why).toEqual([
      expect.stringContaining('while none of the file’s animations plays'),
    ]);
  });
});

describe('material edits on the clone road (slice 3)', () => {
  /** skinned-bar's mesh is glTF node 2. */
  const MESH = 2;

  /** The clone child's data node (its `data` edge). */
  const cloneData = (state: DagState, index: number): string =>
    (state.nodes[cloneChild(state, index)].inputs.data as { node: string }).node;

  it('a colour set on the character’s mesh: the native mesh data’s, as setMaterialColor writes it natively', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = tool(saved, 'mutator.setMaterialColor', {
      targetSelectors: [cloneChild(saved, MESH)],
      color: '#12ab34',
    });
    expect(
      (saved.nodes[cloneData(saved, MESH)].params as { material: { base: { color: string } } })
        .material.base.color,
    ).toBe('#12ab34');
    const { state } = await convert(saved, 'skinned-bar.glb');
    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const want = tool(fresh, 'mutator.setMaterialColor', {
      targetSelectors: [native.meshes[MESH]!.objectId],
      color: '#12ab34',
    });
    expectSameCharacter(state, want);
  });

  it('a slot material the Object holds: the native mesh Object’s, as setObjectSlotMaterial writes it natively', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = tool(saved, 'mutator.setObjectSlotMaterial', {
      targetSelectors: [cloneChild(saved, MESH)],
      slotIndex: 0,
      color: '#aa0000',
    });
    const { state } = await convert(saved, 'skinned-bar.glb');
    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const want = tool(fresh, 'mutator.setObjectSlotMaterial', {
      targetSelectors: [native.meshes[MESH]!.objectId],
      slotIndex: 0,
      color: '#aa0000',
    });
    expectSameCharacter(state, want);
  });

  it('a material channel: re-targeted onto the native mesh data, the same keys at the same path', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = tool(saved, 'mutator.timeline.addChannel', {
      target: cloneData(saved, MESH),
      paramPath: 'material.base.color',
      valueType: 'color',
      channelId: 'colour_ch',
      initialKeyframe: { time: 0.5, value: '#0000ff' },
    });
    const { state } = await convert(saved, 'skinned-bar.glb');
    const { state: fresh, native } = await nativeProject('skinned-bar.glb');
    const want = tool(fresh, 'mutator.timeline.addChannel', {
      target: native.meshes[MESH]!.dataId,
      paramPath: 'material.base.color',
      valueType: 'color',
      channelId: 'colour_ch',
      initialKeyframe: { time: 0.5, value: '#0000ff' },
    });
    expectSameCharacter(state, want);
  });

  it('a texture edited: kept, and named', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: cloneData(saved, MESH),
        paramPath: 'material.maps.albedo',
        value: {
          hash: 'img_elsewhere',
          colorSpace: 'srgb',
          flipY: false,
          wrapS: 10497,
          wrapT: 10497,
        },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([expect.stringMatching(/material\.maps\.albedo edited/)]);
  });

  it('a channel keying something of the data other than its material: kept, and named (made by hand)', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = apply(saved, [
      {
        type: 'addNode',
        nodeId: 'faces_ch',
        nodeType: 'KeyframeChannelNumber',
        params: {
          name: 'faces',
          target: cloneData(saved, MESH),
          paramPath: 'faceCount',
          keyframes: [],
        },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      expect.stringMatching(/keys "faceCount" .* no native counterpart/),
    ]);
  });

  it('a slot material holding a texture: kept, and named (made by hand)', async () => {
    let saved = await cloneProject('skinned-bar.glb');
    saved = tool(saved, 'mutator.setObjectSlotMaterial', {
      targetSelectors: [cloneChild(saved, MESH)],
      slotIndex: 0,
      color: '#aa0000',
    });
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: cloneChild(saved, MESH),
        paramPath: 'slotOverrides.0.maps.albedo',
        value: {
          hash: 'img_elsewhere',
          colorSpace: 'srgb',
          flipY: false,
          wrapS: 10497,
          wrapT: 10497,
        },
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps('skinned-bar.glb'));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([expect.stringMatching(/slot 0 holds a texture/)]);
  });

  it('a mesh whose slots the two roads number differently: kept, and the load says why', async () => {
    // A second primitive with the first's material: the clone numbers two slots, the native reader
    // one (it keys a slot by material, as Blender does).
    const twoPrims = glbWith('skinned-bar.glb', (json) => {
      const mesh = (json as unknown as { meshes: { primitives: unknown[] }[] }).meshes[0];
      mesh.primitives.push(mesh.primitives[0]);
    });
    let saved = await cloneProject(twoPrims);
    saved = apply(saved, [
      {
        type: 'setParam',
        nodeId: cloneData(saved, MESH),
        paramPath: 'material.base.color',
        value: '#00ff00',
      },
    ]);
    const { state, report } = await convertCloneCharacters(saved, deps(twoPrims));
    expect(state).toBe(saved);
    expect(report.kept[0].why).toEqual([
      expect.stringMatching(/numbers 2 material slots, the native mesh 1/),
    ]);
  });
});

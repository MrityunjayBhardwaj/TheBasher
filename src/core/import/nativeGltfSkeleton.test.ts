// #393 (step 1) — a skinned glTF's joints become a Skeleton, its standing Object and an
// AnimationClip on the native road, never empties; and ONE function spells both the bone names and
// the mesh's vertex groups.
import { readFileSync } from 'node:fs';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __buildSkinnedNativeGltfImportOpsForTests,
  buildNativeGltfImportOps,
  type NativeImportResult,
} from './nativeGltfImport';
import { nativeBoneNames, nativeSkeletonClip, readNativeSkeletons } from './nativeGltfSkeleton';
import { sampleSkinDeform } from '../../nodes/armatureDeform';
import { parseGltfContainer } from './glb';
import type { ClipChannel, Vec3ClipKey } from './nativeGltfClip';
import { skeletonObjectId, standInObjectOf } from './skeletonObject';
import { __resetRegistryForTests } from '../dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from '../dag/ops';
import { evaluate } from '../dag';
import { emptyDagState, type DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { actionPoseOf, posedSkeletonFromClip } from '../../nodes/AnimationClip';
import { unpackMeshData } from '../../app/meshGeometryData';
import type {
  AnimationClipValue,
  BoneSpec,
  ModifiedDataValue,
  ObjectValue,
} from '../../nodes/types';

const SKINNED_BAR = 'public/assets/skinned-bar.glb';
const STANDIN = 'public/fixtures/rig/standin-character.glb';
const MANY_BONES = 'public/assets/many-bone-rig.glb';

type Json = {
  nodes: Record<string, unknown>[];
  skins: { joints: number[]; skeleton?: number; inverseBindMatrices?: number }[];
  animations?: {
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
};

/** A GLB fixture with its JSON chunk rewritten; the binary chunk is carried over untouched. */
function glbWith(path: string, mutate: (json: Json) => void = () => {}): ArrayBuffer {
  const src = readFileSync(path);
  const jsonLength = src.readUInt32LE(12);
  const json = JSON.parse(src.subarray(20, 20 + jsonLength).toString()) as Json;
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
  const out = Buffer.concat([header, jsonBytes, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

function jsonOf(buffer: ArrayBuffer): Json {
  return parseGltfContainer(buffer).json as unknown as Json;
}

async function importSkinned(buffer: ArrayBuffer): Promise<NativeImportResult> {
  const result = await __buildSkinnedNativeGltfImportOpsForTests({
    buffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  return result;
}

/** Every op but the last (the Group → scene edge, whose target this empty state lacks). */
function applied(ops: readonly Op[]): DagState {
  let state = emptyDagState();
  for (const op of ops.slice(0, -1)) state = applyOp(state, op).next;
  return state;
}

function nodesOfType(state: DagState, type: string): string[] {
  return Object.values(state.nodes)
    .filter((n) => n.type === type)
    .map((n) => n.id);
}

/** The single stored mesh's vertex groups, read back through the saved form. */
function storedVertexGroups(state: DagState): readonly string[] {
  const [meshId] = nodesOfType(state, 'PolyMeshData');
  const data = unpackMeshData((state.nodes[meshId].params as { mesh: never }).mesh);
  return data.vertexGroups;
}

function skeletonBones(state: DagState): readonly BoneSpec[] {
  const [skeletonId] = nodesOfType(state, 'Skeleton');
  return (state.nodes[skeletonId].params as { bones: BoneSpec[] }).bones;
}

describe('#393 step 1 — a skinned glTF’s joints become a skeleton', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('skinned-bar: one Skeleton, its standing Object and one clip — no empty per joint, no channel on a joint', async () => {
    const result = await importSkinned(glbWith(SKINNED_BAR));
    const state = applied(result.ops);
    const types = Object.values(state.nodes)
      .map((n) => n.type)
      .sort();
    // The import Group, the mesh node's Object + PolyMeshData + the Armature modifier that deforms
    // it, and the rig: Skeleton, its Object, its clip. Before #393 the joints were two Group
    // empties with a KeyframeChannelQuat on one.
    expect(types).toEqual([
      'AnimationClip',
      'ArmatureModifier',
      'Group',
      'Object',
      'Object',
      'PolyMeshData',
      'Skeleton',
    ]);
    const [skeletonId] = nodesOfType(state, 'Skeleton');
    expect(skeletonBones(state)).toEqual([
      { name: 'Bone0', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'Bone1', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ]);

    // The standing Object is the FBX/BVH builder's: its derived id, the data edge from the
    // skeleton, and it hangs under the node Blender makes the armature — the mesh node.
    const standIn = standInObjectOf(state, skeletonId);
    expect(standIn).toBe(skeletonObjectId(skeletonId));
    const meshObject = result.objectIds[0];
    const children = state.nodes[meshObject].inputs.children as { node: string }[];
    expect(children.map((c) => c.node)).toEqual([standIn]);
    expect(state.nodes[standIn!].params).toMatchObject({ scale: [1, 1, 1] });
    expect(state.nodes[standIn!].meta?.name).toBe('bend');
    // #1203 — the clip is the Object's action: what the band draws and a deform reads.
    const [clipId] = nodesOfType(state, 'AnimationClip');
    expect(state.nodes[standIn!].inputs.action).toEqual({ node: clipId, socket: 'out' });
    const rig = evaluate(state, standIn!, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as ObjectValue;
    expect(actionPoseOf(rig)?.sample(1)[1].rotation[2]).toBeCloseTo(
      2 * Math.atan2(0.6756, 0.7373),
      3,
    );
  });

  it('skinned-bar: the clip plays on the skeleton, and at 0.5 s Bone1 is half of its 85° bend', async () => {
    const state = applied((await importSkinned(glbWith(SKINNED_BAR))).ops);
    const [clipId] = nodesOfType(state, 'AnimationClip');
    const clip = evaluate(state, clipId, {
      ctx: { time: { frame: 0, seconds: 0, normalized: 0 } },
    }).value as AnimationClipValue;
    expect(clip.skeleton.bones).toHaveLength(2);
    expect(clip.duration).toBe(1);
    const posed = posedSkeletonFromClip(clip);
    // The file's end key: (0, 0, 0.6756, 0.7373), a rotation of 2·atan2(0.6756, 0.7373) about Z.
    const end = 2 * Math.atan2(0.6756, 0.7373);
    expect(posed.sample(1)[1].rotation[2]).toBeCloseTo(end, 3);
    expect(posed.sample(0.5)[1].rotation[2]).toBeCloseTo(end / 2, 3);
    // Bone0 has no channel and holds its rest.
    expect(posed.sample(0.5)[0].rotation).toEqual([0, 0, 0]);
  });

  it('the product entry still refuses a skinned file, until a native character can take a motion (#1205)', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: glbWith(SKINNED_BAR),
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    expect(result).toMatchObject({ issue: '#1205' });
  });

  it('past the refusal, nothing points at the file: no asset, no clone, no reference to it', async () => {
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: glbWith(SKINNED_BAR),
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    const text = JSON.stringify(result.ops);
    expect(text).not.toContain('GltfAsset');
    expect(text).not.toContain('GltfData');
    expect(text).not.toContain('skinned-bar.glb');
  });

  it('the stand-in rig: 23 bones under the mesh node, the matrix-form Root decomposed, every group a bone', async () => {
    const state = applied((await importSkinned(glbWith(STANDIN))).ops);
    const bones = skeletonBones(state);
    expect(bones).toHaveLength(23);
    expect(bones[0].name).toBe('Root');
    // Root is stored as a matrix (a quarter turn); its rest, composed back, is that matrix.
    const fileMatrix = jsonOf(glbWith(STANDIN)).nodes[22].matrix as number[];
    const composed = new Matrix4().compose(
      new Vector3(...bones[0].position),
      new Quaternion().setFromEuler(new Euler(...bones[0].rotation, 'XYZ')),
      new Vector3(...(bones[0].scale ?? [1, 1, 1])),
    );
    composed.elements.forEach((e, k) => expect(e).toBeCloseTo(fileMatrix[k], 6));
    expect(bones.filter((b) => b.parent === -1)).toHaveLength(1);
    // 22 of 23 file names carry ':', which three reserves; the stored spelling replaces it.
    expect(bones.some((b) => b.name.includes(':'))).toBe(false);
    expect(bones.map((b) => b.name)).toContain('mixamorig_Hips');
    // Parents precede children, so every bone's parent is already placed when it is read.
    bones.forEach((b, i) => expect(b.parent).toBeLessThan(i));
  });

  // ── ONE SPELLING, TWO WRITERS ─────────────────────────────────────────────────────────────────
  // Blender measured (q12): glTF import keeps names identical on both sides, 23/23 on the stand-in,
  // and dedups duplicates as Bone / Bone.001 on both. The join is by name, so a divergence here is
  // a mesh bound to bones that do not exist, which deforms nothing (Blender row B).
  describe.each([
    ['skinned-bar', SKINNED_BAR, (_: Json) => {}],
    ['the stand-in rig', STANDIN, (_: Json) => {}],
    ['many-bone-rig', MANY_BONES, (_: Json) => {}],
    [
      'skinned-bar with both joints named "Bone"',
      SKINNED_BAR,
      (json: Json) => {
        for (const joint of json.skins[0].joints) json.nodes[joint].name = 'Bone';
      },
    ],
    [
      'skinned-bar with reserved characters and an unnamed joint',
      SKINNED_BAR,
      (json: Json) => {
        json.nodes[1].name = 'rig:Bone[0]';
        delete json.nodes[0].name;
      },
    ],
  ])('%s', (_label, path, mutate) => {
    it('every stored vertex group is spelled exactly as the bone its joint number names', async () => {
      const buffer = glbWith(path, mutate);
      const json = jsonOf(buffer);
      const state = applied((await importSkinned(buffer)).ops);
      const bones = skeletonBones(state);
      const groups = storedVertexGroups(state);
      expect(groups).toHaveLength(json.skins[0].joints.length);
      const boneNames = new Set(bones.map((b) => b.name));
      expect(groups.filter((g) => !boneNames.has(g))).toEqual([]);
      expect(boneNames.size).toBe(bones.length); // unique, so a name join is unambiguous
      // And each group is the bone of ITS joint: joint number i is node skin.joints[i].
      const read = readNativeSkeletons(json as never);
      if (read === null || 'refused' in read) throw new Error('no skeleton');
      const [skeleton] = read.skeletons;
      json.skins[0].joints.forEach((node, i) => {
        expect(groups[i]).toBe(bones[skeleton.boneNodes.indexOf(node)].name);
      });
    });
  });

  it('duplicates dedup in Blender’s creation order: the parent keeps "Bone", the child is "Bone.001"', async () => {
    const state = applied(
      (
        await importSkinned(
          glbWith(SKINNED_BAR, (json) => {
            for (const joint of json.skins[0].joints) json.nodes[joint].name = 'Bone';
          }),
        )
      ).ops,
    );
    expect(skeletonBones(state).map((b) => b.name)).toEqual(['Bone', 'Bone.001']);
    // skin.joints is [1, 0]: joint 0 is node 1 (the parent), joint 1 is node 0 (the child).
    expect(storedVertexGroups(state)).toEqual(['Bone', 'Bone.001']);
  });

  it('names: sanitised, Node_<index> for an unnamed node, then .001 — one function for both sides', () => {
    const json = {
      nodes: [{ name: 'a:b' }, {}, { name: 'a_b' }, { name: 'a:b' }],
    } as never;
    expect(nativeBoneNames(json, [0, 1, 2, 3])).toEqual(['a_b', 'Node_1', 'a_b.001', 'a_b.002']);
  });

  it('a node between two joints is a bone, so the joint below it stays where the file puts it', async () => {
    // Insert a non-joint node "Mid" between Bone0 and Bone1: Bone0 → Mid (0, 0.5, 0) → Bone1 (0, 0.5, 0).
    const buffer = glbWith(SKINNED_BAR, (json) => {
      const mid = json.nodes.length;
      json.nodes.push({ name: 'Mid', translation: [0, 0.5, 0], children: [0] });
      json.nodes[1].children = [mid];
      json.nodes[0].translation = [0, 0.5, 0];
    });
    const state = applied((await importSkinned(buffer)).ops);
    expect(skeletonBones(state).map((b) => [b.name, b.parent, b.position])).toEqual([
      ['Bone0', -1, [0, 0, 0]],
      ['Mid', 0, [0, 0.5, 0]],
      ['Bone1', 1, [0, 0.5, 0]],
    ]);
    // Mid is a bone the skin does not weight: it is in the skeleton, not in the groups.
    expect(storedVertexGroups(state)).toEqual(['Bone0', 'Bone1']);
  });

  // ── WHAT A CLIP OR THE NATIVE MODEL CANNOT HOLD IS REFUSED WHOLE, BY NAME ─────────────────────
  // #1212 — a bone's scale channel that HOLDS the rest scale changes no pose (the clip already
  // rests an unkeyed channel there), so it is dropped and counted; one that scales is refused.
  describe('#1212 — a bone scale channel', () => {
    /** Bone1's first skeleton, read from skinned-bar with `mutate` applied. */
    const skeletonOf = (mutate?: (json: Json) => void) => {
      const json = jsonOf(glbWith(SKINNED_BAR, mutate));
      const read = readNativeSkeletons(json as never);
      if (read === null || 'refused' in read) throw new Error('no skeleton');
      return { json, skeleton: read.skeletons[0] };
    };
    const linear = (time: number, value: [number, number, number]) => ({
      time,
      value,
      easing: 'linear' as const,
    });
    const scaleOn = (node: number, keyframes: Vec3ClipKey[]): ClipChannel[] => [
      { node, path: 'scale', keyframes },
    ];

    it('at the rest scale is dropped, counted, and still counts toward the length', () => {
      const { json, skeleton } = skeletonOf();
      expect(
        nativeSkeletonClip(
          skeleton,
          scaleOn(0, [linear(0, [1, 1, 1]), linear(3, [1, 1, 1])]),
          json as never,
        ),
      ).toEqual({ keyframes: [], duration: 3, restScaleChannels: 1 });
    });

    it('away from the rest scale is refused, naming the bone', () => {
      const { json, skeleton } = skeletonOf();
      expect(
        nativeSkeletonClip(skeleton, scaleOn(0, [linear(0, [1.5, 1, 1])]), json as never),
      ).toEqual({
        refused:
          'its clip scales bone Bone1 away from its rest scale, and a clip key holds no scale',
        issue: '#1212',
      });
    });

    it('is measured against the bone’s OWN rest scale, not against 1', () => {
      const { json, skeleton } = skeletonOf((j) => {
        j.nodes[0].scale = [2, 2, 2];
      });
      const at = (v: number) =>
        nativeSkeletonClip(skeleton, scaleOn(0, [linear(0, [v, v, v])]), json as never);
      expect(at(2)).toMatchObject({ restScaleChannels: 1 });
      expect(at(1)).toMatchObject({ issue: '#1212' });
    });

    it('holds within 1e-4 of the rest and not beyond', () => {
      const { json, skeleton } = skeletonOf();
      const at = (v: number) =>
        nativeSkeletonClip(skeleton, scaleOn(0, [linear(0, [v, 1, 1])]), json as never);
      expect(at(1 + 0.9e-4)).toMatchObject({ restScaleChannels: 1 });
      expect(at(1 + 1.1e-4)).toMatchObject({ issue: '#1212' });
    });

    it('a CUBICSPLINE channel at rest with a tangent that swings between keys is refused', () => {
      const { json, skeleton } = skeletonOf();
      const cubic = (outY: number): Vec3ClipKey[] => [
        {
          time: 0,
          value: [1, 1, 1],
          easing: 'cubic',
          outHandle: { time: 1 / 3, value: [0, outY, 0] },
        },
        {
          time: 1,
          value: [1, 1, 1],
          easing: 'cubic',
          inHandle: { time: -1 / 3, value: [0, 0, 0] },
        },
      ];
      expect(nativeSkeletonClip(skeleton, scaleOn(0, cubic(0)), json as never)).toMatchObject({
        restScaleChannels: 1,
      });
      expect(nativeSkeletonClip(skeleton, scaleOn(0, cubic(0.5)), json as never)).toMatchObject({
        issue: '#1212',
      });
    });

    it('on a node that is not a bone is not this clip’s, and passes uncounted', () => {
      const { json, skeleton } = skeletonOf();
      expect(
        nativeSkeletonClip(skeleton, scaleOn(2, [linear(0, [3, 3, 3])]), json as never),
      ).toEqual({ keyframes: [], duration: 0, restScaleChannels: 0 });
    });
  });

  /** A second mesh like mesh 0, so a row is not refused first for sharing one (#1061). */
  const copyOfMesh0 = (json: Json): number => {
    const meshes = (json as unknown as { meshes: unknown[] }).meshes;
    meshes.push(structuredClone(meshes[0]));
    return meshes.length - 1;
  };

  it.each<[string, (json: Json) => void, string, string]>([
    [
      'a bone channel is STEP',
      (json) => {
        json.animations![0].samplers[0].interpolation = 'STEP';
      },
      'moves bone Bone1 by STEP',
      '#393',
    ],
    [
      // #1219 — a MESH under a bone comes across parented to it (#1210); an empty does not yet.
      'an empty hangs under a bone',
      (json) => {
        json.nodes.push({ name: 'Socket' });
        json.nodes[0].children = [json.nodes.length - 1];
      },
      'node 3 is an empty under bone node 0',
      '#1219',
    ],
    [
      // A skinned node under a bone that has a child would be left behind there as an empty.
      'a skinned node with a child hangs under a bone',
      (json) => {
        json.nodes.push({ name: 'Tag' });
        json.nodes.push({
          name: 'Skin2',
          mesh: copyOfMesh0(json),
          skin: 0,
          children: [json.nodes.length - 1],
        });
        json.nodes[0].children = [json.nodes.length - 1];
      },
      'node 4 is an empty under bone node 0',
      '#1219',
    ],
    [
      // …and one that is animated, the other half of the same rule (#1221).
      'an animated skinned node hangs under a bone',
      (json) => {
        json.nodes.push({ name: 'Skin2', mesh: copyOfMesh0(json), skin: 0 });
        json.nodes[0].children = [json.nodes.length - 1];
        json.animations![0].channels.push({
          sampler: 0,
          target: { node: json.nodes.length - 1, path: 'rotation' },
        });
      },
      'node 3 is an empty under bone node 0',
      '#1219',
    ],
    [
      'a bone is also a mesh',
      (json) => {
        json.nodes[0].mesh = copyOfMesh0(json);
      },
      'node 0 is both a bone and a mesh',
      '#1209',
    ],
  ])('refused: %s', async (_label, mutate, why, issue) => {
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: glbWith(SKINNED_BAR, mutate),
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    expect(result).toMatchObject({ issue });
    expect('refused' in result && result.refused).toContain(why);
  });
});

describe('#1208 — several skins: one skeleton and one armature Object per armature, as Blender makes them', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  const TWO_BARS = 'public/assets/two-skinned-bars.glb';
  /** Blender 5.1.1 on two-skinned-bars.glb (ref/probes/blender-native-character/
   *  q1208_two_skins_oracle.py), each bar's tip in glTF world space at 0 / 0.5 / 1 s. Bar B's armature
   *  node stands at (3, 0, 0), so its mesh-local tip is the world tip less that. */
  const BLENDER = {
    a: { rest: [0.2, 2, 0], 0.5: [-0.528135, 1.872395, 0], 1: [-0.978764, 1.286394, 0] },
    b: { rest: [2.8, 2, 0], 0.5: [3.528135, 1.872395, 0], 1: [3.978764, 1.286395, 0] },
  } as const;
  const B_ARMATURE = [3, 0, 0];

  /** Every skinned mesh's modifier, with the Skeleton behind the Object its armature edge names. */
  function deforms(state: DagState): { modifierId: string; skeletonId: string }[] {
    return Object.values(state.nodes)
      .filter((n) => n.type === 'ArmatureModifier')
      .map((n) => {
        const object = (n.inputs.armature as { node: string }).node;
        return {
          modifierId: n.id,
          skeletonId: (state.nodes[object].inputs.data as { node: string }).node,
        };
      });
  }

  function tipAt(state: DagState, modifierId: string, rest: readonly number[], t: number) {
    const ctx = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };
    const value = evaluate(state, modifierId, ctx).value as ModifiedDataValue;
    if (value.kind !== 'ModifiedData' || !value.skin || value.geometry.descriptor.kind !== 'mesh')
      throw new Error('not a skinned stored mesh');
    const mesh = value.geometry.descriptor.data;
    let tip = -1;
    for (let p = 0; p * 3 < mesh.points.length; p++) {
      const q = mesh.points.subarray(p * 3, p * 3 + 3);
      if (q.every((c, k) => Math.abs(c - rest[k]) < 1e-5)) tip = p;
    }
    if (tip < 0) throw new Error(`no point rests at ${rest}`);
    return Array.from(sampleSkinDeform(value.skin, mesh, t).subarray(tip * 3, tip * 3 + 3));
  }

  it('two rigs under two nodes: two Skeletons, two Objects, each mesh deformed by its own', async () => {
    const state = applied((await importSkinned(glbWith(TWO_BARS))).ops);
    expect(nodesOfType(state, 'Skeleton')).toHaveLength(2);
    const pairs = deforms(state);
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((p) => p.skeletonId)).size).toBe(2);
    // Names are unique within an armature, as Blender's are: both rigs keep Bone0 / Bone1.
    for (const id of nodesOfType(state, 'Skeleton')) {
      const bones = (state.nodes[id].params as { bones: BoneSpec[] }).bones;
      expect(bones.map((b) => b.name)).toEqual(['Bone0', 'Bone1']);
    }
  });

  it.each([0.5, 1] as const)("at %s s each bar's tip is where Blender puts it", async (t) => {
    const state = applied((await importSkinned(glbWith(TWO_BARS))).ops);
    const [first, second] = deforms(state)
      .map((d) => d.modifierId)
      .sort();
    // Which modifier is which bar: the one whose mesh has a point resting at A's local tip.
    const rows: number[][] = [];
    for (const modifierId of [first, second]) {
      try {
        const a = tipAt(state, modifierId, BLENDER.a.rest, t);
        a.forEach((c, k) => expect(c, `bar A axis ${k}`).toBeCloseTo(BLENDER.a[t][k], 4));
        rows.push(a);
      } catch {
        const localRest = BLENDER.b.rest.map((c, k) => c - B_ARMATURE[k]);
        const b = tipAt(state, modifierId, localRest, t);
        b.forEach((c, k) =>
          expect(c + B_ARMATURE[k], `bar B axis ${k}`).toBeCloseTo(BLENDER.b[t][k], 4),
        );
        rows.push(b);
      }
    }
    expect(rows).toHaveLength(2);
  });

  it('two skins over the same joints (a body and its eyes) share ONE skeleton', async () => {
    // A second skinned mesh node on a copy of skin 0: same joints, so the same armature node.
    const state = applied(
      (
        await importSkinned(
          glbWith(SKINNED_BAR, (json) => {
            json.skins.push({ ...json.skins[0] });
            const meshNode = json.nodes.findIndex((n) => typeof n.skin === 'number');
            const meshes = (json as unknown as { meshes: unknown[] }).meshes;
            meshes.push({ ...(meshes[json.nodes[meshNode].mesh as number] as object) });
            const copy = {
              ...json.nodes[meshNode],
              name: 'Eyes',
              skin: 1,
              mesh: meshes.length - 1,
            };
            json.nodes.push(copy);
            const holder = json.nodes.findIndex((n) =>
              ((n.children as number[] | undefined) ?? []).includes(meshNode),
            );
            if (holder >= 0) (json.nodes[holder].children as number[]).push(json.nodes.length - 1);
            else
              (json as unknown as { scenes: { nodes: number[] }[] }).scenes[0].nodes.push(
                json.nodes.length - 1,
              );
          }),
        )
      ).ops,
    );
    expect(nodesOfType(state, 'Skeleton')).toHaveLength(1);
    const pairs = deforms(state);
    expect(pairs).toHaveLength(2);
    expect(new Set(pairs.map((p) => p.skeletonId)).size).toBe(1);
  });
});

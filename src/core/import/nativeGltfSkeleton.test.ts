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
import { nativeBoneNames, nativeSkeletonClip, readNativeSkeleton } from './nativeGltfSkeleton';
import { parseGltfContainer } from './glb';
import { skeletonObjectId, standInObjectOf } from './skeletonObject';
import { __resetRegistryForTests } from '../dag/registry';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from '../dag/ops';
import { evaluate } from '../dag';
import { emptyDagState, type DagState } from '../dag/state';
import type { Op } from '../dag/types';
import { actionPoseOf, posedSkeletonFromClip } from '../../nodes/AnimationClip';
import { unpackMeshData } from '../../app/meshGeometryData';
import type { AnimationClipValue, BoneSpec, ObjectValue } from '../../nodes/types';

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
    // The import Group, the mesh node's Object + PolyMeshData, and the rig: Skeleton, its Object,
    // its clip. Before #393 the joints were two Group empties with a KeyframeChannelQuat on one.
    expect(types).toEqual([
      'AnimationClip',
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

  it('the product entry still refuses a skinned file, until the skin draws (#1197)', async () => {
    const result = await buildNativeGltfImportOps({
      buffer: glbWith(SKINNED_BAR),
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    expect(result).toMatchObject({ issue: '#393' });
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
      const skeleton = readNativeSkeleton(json as never);
      if (skeleton === null || 'refused' in skeleton) throw new Error('no skeleton');
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
  it('refused: a bone’s scale is animated, because a clip key holds no scale', () => {
    const json = jsonOf(glbWith(SKINNED_BAR));
    const skeleton = readNativeSkeleton(json as never);
    if (skeleton === null || 'refused' in skeleton) throw new Error('no skeleton');
    const scale = [{ time: 0, value: [1, 1, 1] as const, easing: 'linear' as const }];
    expect(
      nativeSkeletonClip(
        skeleton,
        [{ node: 0, path: 'scale', keyframes: [...scale] }],
        json as never,
      ),
    ).toEqual({
      refused: 'its clip scales bone Bone1, and a clip key holds no scale',
      issue: '#393',
    });
    // A scale on a node that is not a bone is not this clip's, and passes.
    expect(
      nativeSkeletonClip(
        skeleton,
        [{ node: 2, path: 'scale', keyframes: [...scale] }],
        json as never,
      ),
    ).toEqual({ keyframes: [], duration: 0 });
  });

  it.each<[string, (json: Json) => void, string]>([
    [
      'a bone channel is STEP',
      (json) => {
        json.animations![0].samplers[0].interpolation = 'STEP';
      },
      'moves bone Bone1 by STEP',
    ],
    [
      'the file has two skins',
      (json) => {
        json.skins.push({ ...json.skins[0] });
      },
      'it has 2 skins',
    ],
    [
      'a node hangs under a bone',
      (json) => {
        json.nodes.push({ name: 'Prop' });
        json.nodes[0].children = [json.nodes.length - 1];
      },
      'hangs under bone node 0',
    ],
  ])('refused: %s', async (_label, mutate, why) => {
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: glbWith(SKINNED_BAR, mutate),
      assetRef: 'user-imports/native/skinned-bar.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    expect(result).toMatchObject({ issue: '#393' });
    expect('refused' in result && result.refused).toContain(why);
  });
});

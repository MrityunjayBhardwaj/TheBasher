// #1197 — the native skinned draw equals the Armature modifier's answer, vertex for vertex, read
// through three's own skinning (`SkinnedMesh.getVertexPosition`, the CPU twin of the GPU shader).
import { posedSkeletonFromClip } from '../nodes/AnimationClip';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DetachedBindMode,
  SkinnedMesh,
  Uint16BufferAttribute,
  Float32BufferAttribute,
  Vector3,
} from 'three';
import { buildNativeGltfImportOps } from '../core/import/nativeGltfImport';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../core/dag/ops';
import { evaluate } from '../core/dag';
import { emptyDagState } from '../core/dag/state';
import { sampleSkinDeform, boneOfGroups } from '../nodes/armatureDeform';
import { SKIN_JOINTS, SKIN_WEIGHTS } from '../nodes/attributes';
import type {
  BoneSpec,
  MeshGeometryData,
  ModifiedDataValue,
  SkinDeformValue,
} from '../nodes/types';
import { buildMeshGeometry } from './meshGeometryData';
import { meshSplitLayout } from './polygonLayout';
import { buildSkinnedDraw, skinnedDrawKey } from './skinnedDraw';
import { cloneForOverlay } from '../nodes/overlayChannels';
import { clipValueFromKeys } from '../test-utils/clipValue';

const CTX = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** A fixture imported natively, and its Armature modifier's value. */
async function modifierOf(
  path: string,
): Promise<{ skin: SkinDeformValue; mesh: MeshGeometryData }> {
  const bytes = readFileSync(path);
  const result = await buildNativeGltfImportOps({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: `user-imports/native/${path.split('/').pop()}`,
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = emptyDagState();
  for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
  const id = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const value = evaluate(state, id, CTX).value as ModifiedDataValue;
  const descriptor = value.geometry.descriptor;
  if (!value.skin || descriptor.kind !== 'mesh') throw new Error('no skinned stored mesh');
  return { skin: value.skin, mesh: descriptor.data };
}

/** The draw, built as the viewport builds it, and a reader of each drawn vertex in mesh space. */
function drawn(skin: SkinDeformValue, mesh: MeshGeometryData) {
  const draw = buildSkinnedDraw(skin, mesh);
  const geometry = buildMeshGeometry(mesh).geometry;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(draw.skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(draw.skinWeight, 4));
  const skinned = new SkinnedMesh(geometry);
  skinned.bindMode = DetachedBindMode;
  skinned.bind(draw.skeleton, draw.bindMatrix);
  const { vertexCorner } = meshSplitLayout(mesh);
  return {
    /** Pose at 1 s, then with no pose, and read every drawn vertex. */
    restAfterPose(): number[][] {
      draw.pose(1, skin.pose);
      draw.pose(1, null);
      const v3 = new Vector3();
      return Array.from(vertexCorner, (_, v) => skinned.getVertexPosition(v, v3).toArray());
    },
    at(seconds: number): { vertex: number[][]; point: number[][] } {
      draw.pose(seconds, skin.pose);
      const expected = sampleSkinDeform(skin, mesh, seconds);
      const vertex: number[][] = [];
      const point: number[][] = [];
      const v3 = new Vector3();
      for (let v = 0; v < vertexCorner.length; v++) {
        vertex.push(skinned.getVertexPosition(v, v3).toArray());
        const p = mesh.cornerPoints[vertexCorner[v]];
        point.push(Array.from(expected.subarray(p * 3, p * 3 + 3)));
      }
      return { vertex, point };
    },
  };
}

function expectEqualEverywhere({ vertex, point }: { vertex: number[][]; point: number[][] }) {
  let worst = 0;
  vertex.forEach((v, i) => {
    worst = Math.max(worst, Math.hypot(v[0] - point[i][0], v[1] - point[i][1], v[2] - point[i][2]));
  });
  expect(worst).toBeLessThan(1e-5);
}

describe('#1197 — what is drawn is what the modifier evaluates', () => {
  it.each([
    ['skinned-bar', 'public/assets/skinned-bar.glb'],
    ['many-bone-rig', 'public/assets/many-bone-rig.glb'],
  ])(
    '%s: every drawn vertex equals the modifier’s point, across the clip',
    async (_label, path) => {
      const { skin, mesh } = await modifierOf(path);
      const draw = drawn(skin, mesh);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) expectEqualEverywhere(draw.at(t));
    },
  );

  it('skinned-bar: the drawn tip is Blender’s at frames 12 and 24', async () => {
    const { skin, mesh } = await modifierOf('public/assets/skinned-bar.glb');
    const draw = drawn(skin, mesh);
    const tipOf = ({ vertex }: { vertex: number[][] }, rest: number[][]) =>
      vertex[rest.findIndex((p) => Math.abs(p[0] - 0.2) < 1e-6 && Math.abs(p[1] - 2) < 1e-6)];
    const rest = draw.at(0).point;
    const mid = tipOf(draw.at(0.5), rest);
    const end = tipOf(draw.at(1), rest);
    [-0.528135, 1.872395, 0].forEach((v, k) => expect(mid[k]).toBeCloseTo(v, 3));
    [-0.978764, 1.286395, 0].forEach((v, k) => expect(end[k]).toBeCloseTo(v, 3));
  });

  it('the bind-pose control: with no pose, every drawn vertex is the stored mesh', async () => {
    const { skin, mesh } = await modifierOf('public/assets/skinned-bar.glb');
    const { vertex } = drawn({ ...skin, pose: null }, mesh).at(0.5);
    const { vertexCorner } = meshSplitLayout(mesh);
    vertex.forEach((v, i) => {
      const p = mesh.cornerPoints[vertexCorner[i]];
      v.forEach((c, k) => expect(c).toBeCloseTo(mesh.points[p * 3 + k], 6));
    });
  });
});

// The join rows the modifier honours, drawn: an unmatched group, a half-unmatched point, a zero-sum
// point, and an armature placed off the mesh's origin. One triangle, all three corners bound alike
// per case, at the tip of a two-bone chain whose second bone turns 90° about Z.
const BONES: BoneSpec[] = [
  { name: 'Root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
  { name: 'Tip', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
];
const TURN = clipValueFromKeys({
  kind: 'AnimationClip',
  name: 'turn',
  duration: 1,
  loop: 'hold',
  keyframes: [
    { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 1, 0], rotation: [0, 0, Math.PI / 2] },
  ],
  skeleton: { kind: 'Skeleton', bones: BONES },
});

function triangle(groups: string[], lanes: [number, number][], at: number[]): MeshGeometryData {
  const joints = new Int32Array(12);
  const weights = new Float32Array(12);
  for (let p = 0; p < 3; p++) {
    lanes.forEach(([j, w], lane) => {
      joints[p * 4 + lane] = j;
      weights[p * 4 + lane] = w;
    });
  }
  return {
    points: Float32Array.from([...at, at[0] + 0.1, at[1], at[2], at[0], at[1], at[2] + 0.1]),
    faceSizes: Uint32Array.from([3]),
    cornerPoints: Uint32Array.from([0, 1, 2]),
    cornerLayers: [],
    cornerNormals: null,
    faceLayers: [],
    pointLayers: [
      { name: SKIN_JOINTS, type: 'int4', data: joints },
      { name: SKIN_WEIGHTS, type: 'float4', data: weights },
    ],
    vertexGroups: groups,
  };
}

function skinOf(
  groups: string[],
  armatureMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
): SkinDeformValue {
  return {
    kind: 'SkinDeform',
    bones: BONES,
    pose: posedSkeletonFromClip(TURN),
    boneOfGroup: boneOfGroups(groups, BONES),
    armatureMatrix,
  };
}

describe('#1197 — the join rows, drawn as the modifier evaluates them', () => {
  it.each<[string, string[], [number, number][], number[], number[] | undefined]>([
    ['wholly on Tip', ['Root', 'Tip'], [[1, 1]], [0, 2, 0], undefined],
    ['a group no bone has', ['Root', 'Renamed'], [[1, 1]], [0, 2, 0], undefined],
    [
      'half on Tip, half unmatched',
      ['Tip', 'Nowhere'],
      [
        [0, 0.5],
        [1, 0.5],
      ],
      [0, 2, 0],
      undefined,
    ],
    [
      'half on Root, half on Tip',
      ['Root', 'Tip'],
      [
        [0, 0.5],
        [1, 0.5],
      ],
      [0, 2, 0],
      undefined,
    ],
    ['zero weight', ['Root', 'Tip'], [[1, 0]], [0, 2, 0], undefined],
    [
      'an armature 5 to the right',
      ['Root', 'Tip'],
      [[1, 1]],
      [5, 2, 0],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    ],
  ])('%s', (_label, groups, lanes, at, placement) => {
    const skin = skinOf(groups, placement);
    const draw = drawn(skin, triangle(groups, lanes, at));
    for (const t of [0, 0.5, 1]) expectEqualEverywhere(draw.at(t));
  });
});

describe('#1207 — the draw is built once per content, and the pose is read per frame', () => {
  it('an overlay’s copy of the skin keeps the build key; a changed binding does not', async () => {
    const { skin } = await modifierOf('public/assets/skinned-bar.glb');
    const key = skinnedDrawKey('mesh|k', skin);
    expect(skinnedDrawKey('mesh|k', cloneForOverlay(skin))).toBe(key);
    expect(skinnedDrawKey('mesh|k', { ...skin, boneOfGroup: [1, 0] })).not.toBe(key);
    expect(skinnedDrawKey('mesh|other', skin)).not.toBe(key);
    // The pose is not part of it: a different pose poses the same build.
    expect(skinnedDrawKey('mesh|k', { ...skin, pose: null })).toBe(key);
  });

  it('posing with no pose returns the bones to rest after a pose', async () => {
    const { skin, mesh } = await modifierOf('public/assets/skinned-bar.glb');
    const draw = drawn(skin, mesh);
    const posed = draw.at(1).vertex;
    const rest = drawn({ ...skin, pose: null }, mesh).at(0).vertex;
    expect(posed).not.toEqual(rest);
    // The same build, posed at 1 s and then with its pose taken away, draws the rest again.
    expectEqualEverywhere({ vertex: draw.restAfterPose(), point: rest });
  });
});

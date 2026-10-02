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
import { buildDeformedDraw, buildSkinnedDraw, gpuSkinnable, skinnedDrawKey } from './skinnedDraw';
import { skinLanes, skinPointLayers, skinSetCount } from '../nodes/skinInfluences';
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

// ── #1430 — a point bound to more than four bones ─────────────────────────────────────────────

/**
 * The Blender oracle for `skinned-many-influences.glb` (`scripts/gen-many-influence-fixture.mjs`):
 * Blender 5.1.1's import, each vertex's evaluated position in glTF space at frames 12 and 24 of 24
 * fps, keyed by where the vertex rests. Blender keeps all five influences of the vertex at (0, 2)
 * and all six of the one at (1, 2).
 */
const BLENDER_MANY: Record<string, { half: number[]; one: number[] }> = {
  '0,2': { half: [-0.191784, 1.431651, 0], one: [-0.108796, 0.871343, 0] },
  '1,2': { half: [0.749267, 1.71226, 0], one: [0.674076, 1.370771, 0] },
  '0,0': { half: [0, 0, 0], one: [0, 0, 0] },
  '1,0': { half: [1.918731, -0.706495, 0], one: [3.077697, -0.707708, 0] },
};
const MANY = 'public/assets/skinned-many-influences.glb';
const restKey = (mesh: MeshGeometryData, p: number): string =>
  `${Math.round(mesh.points[p * 3])},${Math.round(mesh.points[p * 3 + 1])}`;

describe('#1430 — every influence a file states is imported, deformed and drawn', () => {
  it('a glTF with a second joint set imports, and the mesh stores both sets', async () => {
    const { mesh } = await modifierOf(MANY);
    expect(mesh.vertexGroups).toEqual(['Root', 'B1', 'B2', 'B3', 'B4', 'B5']);
    expect(skinSetCount(mesh)).toBe(2);
    const { joints, weights, width } = skinLanes(mesh)!;
    expect(width).toBe(8);
    // The vertex at (0, 2): five bones, the fifth in the second set.
    const p = [0, 1, 2, 3].find((i) => restKey(mesh, i) === '0,2')!;
    const held = Array.from({ length: width }, (_, lane) => [
      joints[p * width + lane],
      weights[p * width + lane],
    ]).filter(([, w]) => w > 0);
    expect(held.map(([j]) => j)).toEqual([1, 2, 3, 4, 5]);
    [0.3, 0.25, 0.2, 0.15, 0.1].forEach((w, i) => expect(held[i][1]).toBeCloseTo(w, 6));
  });

  it.each([
    [0.5, 'half'],
    [1, 'one'],
  ] as const)('the deform at %s s puts every point where Blender does', async (t, key) => {
    const { skin, mesh } = await modifierOf(MANY);
    const moved = sampleSkinDeform(skin, mesh, t);
    expect(mesh.points.length / 3).toBe(4);
    for (let p = 0; p < 4; p++) {
      const want = BLENDER_MANY[restKey(mesh, p)][key];
      want.forEach((v, k) => expect(moved[p * 3 + k]).toBeCloseTo(v, 4));
    }
  });

  it('control: the same mesh with its second set dropped lands somewhere else', async () => {
    const { skin, mesh } = await modifierOf(MANY);
    const firstSetOnly = { ...mesh, pointLayers: mesh.pointLayers.slice(0, 2) };
    expect(skinSetCount(firstSetOnly)).toBe(1);
    const moved = sampleSkinDeform(skin, firstSetOnly, 1);
    const p = [0, 1, 2, 3].find((i) => restKey(mesh, i) === '0,2')!;
    const want = BLENDER_MANY['0,2'].one;
    expect(Math.hypot(moved[p * 3] - want[0], moved[p * 3 + 1] - want[1])).toBeGreaterThan(0.05);
  });

  it('the four-lane shader cannot draw it, so it is drawn from the deform — and equals it', async () => {
    const { skin, mesh } = await modifierOf(MANY);
    expect(gpuSkinnable(skin, mesh)).toBe(false);
    const geometry = buildMeshGeometry(mesh).geometry;
    const position = Float32Array.from(geometry.getAttribute('position').array);
    const restNormal = Float32Array.from(geometry.getAttribute('normal').array);
    const normal = Float32Array.from(restNormal);
    const draw = buildDeformedDraw(skin, mesh);
    const { vertexCorner } = meshSplitLayout(mesh);
    for (const [t, key] of [
      [0.5, 'half'],
      [1, 'one'],
    ] as const) {
      expect(draw.write(t, skin.pose, position, normal, restNormal)).toBe(true);
      for (let v = 0; v < vertexCorner.length; v++) {
        const p = mesh.cornerPoints[vertexCorner[v]];
        const want = BLENDER_MANY[restKey(mesh, p)][key];
        want.forEach((x, k) => expect(position[v * 3 + k]).toBeCloseTo(x, 4));
      }
    }
    // The same time and pose again writes nothing; no pose puts every vertex back at rest.
    expect(draw.write(1, skin.pose, position, normal, restNormal)).toBe(false);
    expect(draw.write(1, null, position, normal, restNormal)).toBe(true);
    for (let v = 0; v < vertexCorner.length; v++) {
      const p = mesh.cornerPoints[vertexCorner[v]];
      for (let k = 0; k < 3; k++)
        expect(position[v * 3 + k]).toBeCloseTo(mesh.points[p * 3 + k], 6);
    }
    expect(Array.from(normal)).toEqual(Array.from(restNormal));
  });

  it('a normal turns with its point: a vertex wholly on one bone turns by that bone', async () => {
    const { skin, mesh } = await modifierOf(MANY);
    // Tilt the stored normals off the turning axis, so a turn about Z shows.
    const tilted = {
      ...mesh,
      cornerNormals: mesh.cornerNormals!.map((_, i) => (i % 3 === 0 ? 1 : 0)),
    };
    const geometry = buildMeshGeometry(tilted).geometry;
    const position = Float32Array.from(geometry.getAttribute('position').array);
    const restNormal = Float32Array.from(geometry.getAttribute('normal').array);
    const normal = Float32Array.from(restNormal);
    buildDeformedDraw(skin, tilted).write(1, skin.pose, position, normal, restNormal);
    const { vertexCorner } = meshSplitLayout(tilted);
    const at = (key: string): number =>
      Array.from(vertexCorner).findIndex((c) => restKey(tilted, tilted.cornerPoints[c]) === key);
    // (1, 0) is wholly on B5, which turns 75° about Z at 1 s; (0, 0) is wholly on the still Root.
    const b5 = at('1,0');
    const a = (75 * Math.PI) / 180;
    expect(normal[b5 * 3]).toBeCloseTo(Math.cos(a), 5);
    expect(normal[b5 * 3 + 1]).toBeCloseTo(Math.sin(a), 5);
    const root = at('0,0');
    expect([normal[root * 3], normal[root * 3 + 1], normal[root * 3 + 2]]).toEqual([1, 0, 0]);
  });

  it('two sets with at most four bones per point stay on the GPU, packed, and draw the same', async () => {
    const { skin, mesh: one } = await modifierOf('public/assets/skinned-bar.glb');
    // skinned-bar's one set, spread over two: lane 0 moves to the second set's first lane.
    const { joints, weights } = skinLanes(one)!;
    const points = joints.length / 4;
    const wideJoints = new Int32Array(points * 8);
    const wideWeights = new Float32Array(points * 8);
    for (let p = 0; p < points; p++) {
      for (let lane = 0; lane < 4; lane++) {
        const to = lane === 0 ? 4 : lane;
        wideJoints[p * 8 + to] = joints[p * 4 + lane];
        wideWeights[p * 8 + to] = weights[p * 4 + lane];
      }
    }
    const mesh = {
      ...one,
      pointLayers: skinPointLayers({ width: 8, joints: wideJoints, weights: wideWeights }),
    };
    expect(skinSetCount(mesh)).toBe(2);
    expect(gpuSkinnable(skin, mesh)).toBe(true);
    const draw = drawn(skin, mesh);
    for (const t of [0, 0.5, 1]) expectEqualEverywhere(draw.at(t));
    const tip = draw.at(1);
    const i = tip.point.findIndex((p) => Math.abs(p[0] + 0.978764) < 1e-3);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(tip.vertex[i][1]).toBeCloseTo(1.286395, 3);
  });
});

// #393 (step 2) — the Armature modifier deforms a skinned mesh as Blender's does: the oracle is
// Blender 5.1.1 on the same file, and the join rows are Blender's measured behaviour.
import { posedSkeletonFromClip } from './AnimationClip';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { __buildSkinnedNativeGltfImportOpsForTests } from '../core/import/nativeGltfImport';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from './registerAll';
import { applyOp } from '../core/dag/ops';
import { evaluate } from '../core/dag';
import { emptyDagState, type DagState } from '../core/dag/state';
import { SKIN_JOINTS, SKIN_WEIGHTS } from './attributes';
import { boneOfGroups, sampleSkinDeform } from './armatureDeform';
import { cloneForOverlay } from './overlayChannels';
import type { BoneSpec, MeshGeometryData, ModifiedDataValue, SkinDeformValue } from './types';
import { clipValueFromKeys } from '../test-utils/clipValue';

const CTX = { ctx: { time: { frame: 0, seconds: 0, normalized: 0 } } };

/** The Blender oracle: `ref/probes/blender-armature-deform/q13_skinned_bar_oracle.py`, Blender
 *  5.1.1, the tip vertex of skinned-bar.glb in glTF space (24 fps: frame 12 = 0.5 s, 24 = 1 s). */
const BLENDER_TIP = {
  0: [0.2, 2.0, 0.0],
  0.5: [-0.528135, 1.872395, 0.0],
  1: [-0.978764, 1.286395, 0.0],
} as const;

async function skinnedBar(): Promise<{ state: DagState; modifierId: string }> {
  const bytes = readFileSync('public/assets/skinned-bar.glb');
  const result = await __buildSkinnedNativeGltfImportOpsForTests({
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    assetRef: 'user-imports/native/skinned-bar.glb',
    sceneNodeId: 'n_scene',
    storeImage: async () => 'img',
  });
  if ('refused' in result) throw new Error(result.refused);
  let state = emptyDagState();
  for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
  // The import wires the stack itself: PolyMeshData → Armature → the mesh's Object, with the
  // skeleton's Object on the modifier's second input.
  const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
  const meshObject = result.objectIds[0];
  expect((state.nodes[meshObject].inputs.data as { node: string }).node).toBe(modifierId);
  const armature = (state.nodes[modifierId].inputs.armature as { node: string }).node;
  expect(state.nodes[armature].type).toBe('Object');
  expect((state.nodes[armature].inputs.data as { node: string }).node).toBe(
    Object.values(state.nodes).find((n) => n.type === 'Skeleton')!.id,
  );
  return { state, modifierId };
}

function deformed(
  state: DagState,
  modifierId: string,
): { skin: SkinDeformValue; mesh: MeshGeometryData } {
  const value = evaluate(state, modifierId, CTX).value as ModifiedDataValue;
  if (value.kind !== 'ModifiedData' || !value.skin)
    throw new Error('no skin on the modifier value');
  const descriptor = value.geometry.descriptor;
  if (descriptor.kind !== 'mesh') throw new Error('not a stored mesh');
  return { skin: value.skin, mesh: descriptor.data };
}

/** Blender's tip vertex: the one resting at (0.2, 2, 0) — two points share the top height. */
function tipOf(mesh: MeshGeometryData): number {
  for (let p = 0; p * 3 < mesh.points.length; p++) {
    const [x, y, z] = pointAt(mesh.points, p);
    if (Math.abs(x - 0.2) < 1e-6 && Math.abs(y - 2) < 1e-6 && Math.abs(z) < 1e-6) return p;
  }
  throw new Error('skinned-bar has no point at (0.2, 2, 0)');
}

function pointAt(points: Float32Array, p: number): number[] {
  return Array.from(points.subarray(p * 3, p * 3 + 3));
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('#1212 — a file whose bones carry scale channels held at rest comes across', () => {
  // Blender 5.1.1 (ref/probes/blender-native-character/q1212_rest_scale_oracle.py) keys every
  // pose bone's scale at rest on skinned-bar and exports it: two CUBICSPLINE scale channels, with
  // the tangents Blender's Bézier keys give. Re-imported, its tip is where skinned-bar's is.
  const SAMPLED_TIP = {
    0: [0.2, 2.0, 0.0],
    0.5: [-0.528135, 1.872395, 0.0],
    1: [-0.978764, 1.286394, 0.0],
  } as const;

  async function sampled() {
    const bytes = readFileSync('public/assets/skinned-bar-rest-scale.glb');
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      assetRef: 'user-imports/native/skinned-bar-rest-scale.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    let state = emptyDagState();
    for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
    const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
    return { result, state, modifierId };
  }

  it('reads natively and keeps both scale channels as keys, one per bone, as Blender does (#1211)', async () => {
    const { state } = await sampled();
    const layer = Object.values(state.nodes).find((n) => n.type === 'PoseLayer')!;
    const channels = (layer.params as { channels: { bone: string; component: string }[] }).channels;
    expect(
      channels
        .filter((c) => c.component === 'scale')
        .map((c) => c.bone)
        .sort(),
    ).toEqual(['Bone0', 'Bone1']);
  });

  it.each([0, 0.5, 1] as const)('at %s s the tip is where Blender puts it', async (t) => {
    const { state, modifierId } = await sampled();
    const { skin, mesh } = deformed(state, modifierId);
    const tip = pointAt(sampleSkinDeform(skin, mesh, t), tipOf(mesh));
    SAMPLED_TIP[t].forEach((v, k) => expect(tip[k]).toBeCloseTo(v, 4));
  });
});

describe('#393 step 2 — skinned-bar deformed through the graph matches Blender', () => {
  it.each([0, 0.5, 1] as const)(
    'at %s s the tip vertex is where Blender puts it, to 3 decimals',
    async (t) => {
      const { state, modifierId } = await skinnedBar();
      const { skin, mesh } = deformed(state, modifierId);
      const tip = pointAt(sampleSkinDeform(skin, mesh, t), tipOf(mesh));
      BLENDER_TIP[t].forEach((v, k) => expect(tip[k]).toBeCloseTo(v, 3));
    },
  );

  it('the join is by name, once: both groups find their bone', async () => {
    const { state, modifierId } = await skinnedBar();
    const { skin, mesh } = deformed(state, modifierId);
    expect(mesh.vertexGroups).toEqual(['Bone0', 'Bone1']);
    expect(skin.boneOfGroup).toEqual([0, 1]);
  });

  it('the node emits the REST mesh; only the sampler moves points (no geometry keyed per frame)', async () => {
    const { state, modifierId } = await skinnedBar();
    const { mesh } = deformed(state, modifierId);
    const tip = tipOf(mesh);
    expect(pointAt(mesh.points, tip)).toEqual([0.2, 2, 0].map(Math.fround));
  });

  it('muted, the stack hands the mesh back without a skin', async () => {
    const { state, modifierId } = await skinnedBar();
    const muted = applyOp(state, {
      type: 'setParam',
      nodeId: modifierId,
      paramPath: 'muted',
      value: true,
    }).next;
    const value = evaluate(muted, modifierId, CTX).value as { kind: string; skin?: unknown };
    expect(value.skin).toBeUndefined();
  });

  it('the deform is plain data: it survives the copy an overlay makes, and samples the same', async () => {
    const { state, modifierId } = await skinnedBar();
    const { skin, mesh } = deformed(state, modifierId);
    const copied = cloneForOverlay(skin);
    expect(Array.from(sampleSkinDeform(copied, mesh, 0.5))).toEqual(
      Array.from(sampleSkinDeform(skin, mesh, 0.5)),
    );
  });

  it('an armature with no pose rests, and no point moves', async () => {
    const { state, modifierId } = await skinnedBar();
    const { skin, mesh } = deformed(state, modifierId);
    expect(Array.from(sampleSkinDeform({ ...skin, pose: null }, mesh, 0.5))).toEqual(
      Array.from(mesh.points),
    );
  });
});

// ── THE JOIN ROWS, ON A MESH SMALL ENOUGH TO READ ──────────────────────────────────────────────
// Two bones up +Y (Root at 0, Tip at 1), Tip turned 90° about Z at t = 1. One point per case, all
// at (0, 2, 0) — the tip of the chain — so a point that follows Tip lands at (-1, 1, 0).

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

/** One point per binding, all at the chain's tip. `bind` lists [joint, weight] lanes. */
function meshOf(groups: string[], bindings: [number, number][][]): MeshGeometryData {
  const joints = new Int32Array(bindings.length * 4);
  const weights = new Float32Array(bindings.length * 4);
  bindings.forEach((lanes, p) =>
    lanes.forEach(([j, w], lane) => {
      joints[p * 4 + lane] = j;
      weights[p * 4 + lane] = w;
    }),
  );
  return {
    points: Float32Array.from(bindings.flatMap(() => [0, 2, 0])),
    faceSizes: new Uint32Array(0),
    cornerPoints: new Uint32Array(0),
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

function skinFor(groups: string[], armatureMatrix?: number[]): SkinDeformValue {
  return {
    kind: 'SkinDeform',
    bones: BONES,
    pose: posedSkeletonFromClip(TURN),
    boneOfGroup: boneOfGroups(groups, BONES),
    armatureMatrix: armatureMatrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
}

function close(actual: number[], expected: number[]): void {
  expected.forEach((v, k) => expect(actual[k]).toBeCloseTo(v, 6));
}

describe('the join, by Blender’s rules', () => {
  it('a point wholly on Tip follows it', () => {
    const groups = ['Root', 'Tip'];
    const out = sampleSkinDeform(skinFor(groups), meshOf(groups, [[[1, 1]]]), 1);
    close(pointAt(out, 0), [-1, 1, 0]);
  });

  it('row B — a group whose name no bone has contributes nothing: the point stays', () => {
    const groups = ['Root', 'Renamed'];
    const skin = skinFor(groups);
    expect(skin.boneOfGroup).toEqual([0, -1]);
    const out = sampleSkinDeform(skin, meshOf(groups, [[[1, 1]]]), 1);
    close(pointAt(out, 0), [0, 2, 0]);
  });

  it('and it adds nothing to the weight the others divide by: half on Tip, half unmatched, follows Tip fully', () => {
    const groups = ['Tip', 'Nowhere'];
    const out = sampleSkinDeform(
      skinFor(groups),
      meshOf(groups, [
        [
          [0, 0.5],
          [1, 0.5],
        ],
      ]),
      1,
    );
    close(pointAt(out, 0), [-1, 1, 0]);
  });

  it('half on Root, half on Tip, blends linearly between the two', () => {
    const groups = ['Root', 'Tip'];
    const out = sampleSkinDeform(
      skinFor(groups),
      meshOf(groups, [
        [
          [0, 0.5],
          [1, 0.5],
        ],
      ]),
      1,
    );
    close(pointAt(out, 0), [-0.5, 1.5, 0]);
  });

  it('row F — a zero-sum point stays at rest while its neighbour moves', () => {
    const groups = ['Root', 'Tip'];
    const out = sampleSkinDeform(skinFor(groups), meshOf(groups, [[[1, 0]], [[1, 1]]]), 1);
    close(pointAt(out, 0), [0, 2, 0]);
    close(pointAt(out, 1), [-1, 1, 0]);
  });

  it('row C — the order of the groups is irrelevant: the numbers index the table, the names join', () => {
    const forward = sampleSkinDeform(
      skinFor(['Root', 'Tip']),
      meshOf(['Root', 'Tip'], [[[1, 1]]]),
      1,
    );
    const reversed = sampleSkinDeform(
      skinFor(['Tip', 'Root']),
      meshOf(['Tip', 'Root'], [[[0, 1]]]),
      1,
    );
    expect(Array.from(reversed)).toEqual(Array.from(forward));
  });

  it('the armature’s placement moves the pivot: an armature 5 to the right turns the point about its own Tip', () => {
    // The point sits at the moved chain's tip, (5, 2, 0), and follows Tip about (5, 1, 0).
    const groups = ['Root', 'Tip'];
    const mesh = meshOf(groups, [[[1, 1]]]);
    mesh.points.set([5, 2, 0]);
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    close(pointAt(sampleSkinDeform(skinFor(groups, moved), mesh, 1), 0), [4, 1, 0]);
  });
});

describe('#1218 — a skinned mesh under a moved armature stands in the armature’s space, as in Blender', () => {
  async function imported(
    path: string,
  ): Promise<{ state: DagState; objectId: string; modifierId: string }> {
    const bytes = readFileSync(path);
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
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
    const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
    const objectId = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' &&
        (n.inputs.data as { node?: string } | undefined)?.node === modifierId,
    )!.id;
    return { state, objectId, modifierId };
  }
  const parentOf = (state: DagState, id: string) =>
    Object.values(state.nodes).find((n) =>
      ([] as { node: string }[])
        .concat((n.inputs.children as never) ?? [])
        .some((c) => c?.node === id),
    );
  /** The point resting at `rest` in the mesh's stored space, deformed at `t`. */
  function pointAtRest(state: DagState, modifierId: string, rest: number[], t: number): number[] {
    const { skin, mesh } = deformed(state, modifierId);
    for (let p = 0; p * 3 < mesh.points.length; p++) {
      if (pointAt(mesh.points, p).every((c, k) => Math.abs(c - rest[k]) < 1e-5)) {
        return Array.from(sampleSkinDeform(skin, mesh, t).subarray(p * 3, p * 3 + 3));
      }
    }
    throw new Error(`no point rests at ${rest}`);
  }

  // Blender 5.1.1 (ref/probes/blender-native-character/q1218_child_mesh_oracle.py): skinned-bar
  // re-exported with its armature at x = 3 and the mesh node its CHILD. The top corners rest at
  // world (2.8, 2, 0) and (3.2, 2, 0); at frame 12 they are at (2.1770, 1.6022, 0) and
  // (2.4719, 1.8724, 0). In the armature's own space that is the same bend skinned-bar makes.
  it('the mesh hangs under the armature’s node with no transform, its points in that node’s space', async () => {
    const { state, objectId } = await imported('public/assets/skinned-bar-child-mesh.glb');
    const object = state.nodes[objectId].params as { position: number[]; quaternion: number[] };
    expect(object.position).toEqual([0, 0, 0]);
    expect(object.quaternion).toEqual([0, 0, 0, 1]);
    const armatureNode = parentOf(state, objectId)!;
    expect((armatureNode.params as { position: number[] }).position).toEqual([3, 0, 0]);
    // The skeleton's Object stands under the same node, so mesh and armature share one space.
    const skeletonObject = Object.values(state.nodes).find(
      (n) =>
        n.type === 'Object' &&
        state.nodes[(n.inputs.data as { node?: string })?.node ?? '']?.type === 'Skeleton',
    )!;
    expect(parentOf(state, skeletonObject.id)!.id).toBe(armatureNode.id);
  });

  it.each([
    [
      [-0.2, 2, 0],
      [2.177, 1.6022, 0],
    ],
    [
      [0.2, 2, 0],
      [2.4719, 1.8724, 0],
    ],
  ])(
    'the point resting at armature-space %j lands where Blender puts it at 0.5 s',
    async (rest, world) => {
      const { state, modifierId } = await imported('public/assets/skinned-bar-child-mesh.glb');
      const moved = pointAtRest(state, modifierId, rest, 0.5);
      // World = the armature node's (3, 0, 0) + the armature-space point.
      moved.forEach((c, k) => expect(c + [3, 0, 0][k], `axis ${k}`).toBeCloseTo(world[k], 3));
    },
  );

  it('a skinned mesh node elsewhere in the file, with a transform of its own, still stands under its armature', async () => {
    // skinned-bar-child-mesh with the mesh node moved to the scene root and given t = (5, 0, 0).
    // glTF places a skinned mesh by its joints alone; Blender 5.1.1 reparents it under SkinnedBar at
    // location 0 and draws the corners exactly as in the child-mesh file (frame 12: (2.1770,
    // 1.6022, 0) and (2.4719, 1.8724, 0)) — q1218_elsewhere.py.
    const { state, objectId, modifierId } = await imported(
      'public/assets/skinned-bar-mesh-elsewhere.glb',
    );
    expect((state.nodes[objectId].params as { position: number[] }).position).toEqual([0, 0, 0]);
    expect((parentOf(state, objectId)!.params as { position: number[] }).position).toEqual([
      3, 0, 0,
    ]);
    const moved = pointAtRest(state, modifierId, [0.2, 2, 0], 0.5);
    moved.forEach((c, k) =>
      expect(c + [3, 0, 0][k], `axis ${k}`).toBeCloseTo([2.4719, 1.8724, 0][k], 3),
    );
  });

  it('a skinned node with a child stays behind as an empty; the mesh hangs under the armature', async () => {
    // skinned-bar-mesh-elsewhere plus a child "Tag" under the mesh node. Blender 5.1.1
    // (q1218_left.py): Mesh_0 becomes an EMPTY at (5, 0, 0) that keeps Tag, and a new Mesh_0.001
    // hangs under SkinnedBar with no transform (`vnode.py:398-408`).
    const src = readFileSync('public/assets/skinned-bar-mesh-elsewhere.glb');
    const length = src.readUInt32LE(12);
    const json = JSON.parse(src.subarray(20, 20 + length).toString());
    json.nodes.push({ name: 'Tag', translation: [0, 1, 0] });
    json.nodes[2].children = [json.nodes.length - 1];
    let text = JSON.stringify(json);
    text += ' '.repeat((4 - (text.length % 4)) % 4);
    const head = Buffer.alloc(20);
    const body = Buffer.from(text);
    const rest = src.subarray(20 + length);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + body.length + rest.length, 8);
    head.writeUInt32LE(body.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    const out = Buffer.concat([head, body, rest]);
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
      assetRef: 'user-imports/native/with-child.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    let state = emptyDagState();
    for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
    const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
    const mesh = Object.values(state.nodes).find(
      (n) => (n.inputs.data as { node?: string } | undefined)?.node === modifierId,
    )!;
    expect((mesh.params as { position: number[] }).position).toEqual([0, 0, 0]);
    expect((parentOf(state, mesh.id)!.params as { position: number[] }).position).toEqual([
      3, 0, 0,
    ]);
    // The node left behind: an empty at the file's (5, 0, 0), still holding its child.
    const tag = Object.values(state.nodes).find((n) => n.meta?.name === 'Tag')!;
    const behind = parentOf(state, tag.id)!;
    expect(behind.type).toBe('Group');
    expect((behind.params as { position: number[] }).position).toEqual([5, 0, 0]);
  });

  it('an ANIMATED skinned node stays behind as an empty too, keeping its motion', async () => {
    // The other half of the same rule (#1221): Blender moves a skinned node only when it is not
    // animated and has no children (`vnode.py`, `move_skinned_meshes`, `ok_to_move`); otherwise
    // the node stays, as an empty, and a new object under the armature takes the mesh. Here
    // skinned-bar-mesh-elsewhere's mesh node gains a rotation channel of its own.
    const src = readFileSync('public/assets/skinned-bar-mesh-elsewhere.glb');
    const length = src.readUInt32LE(12);
    const json = JSON.parse(src.subarray(20, 20 + length).toString());
    json.animations[0].channels.push({ sampler: 0, target: { node: 2, path: 'rotation' } });
    let text = JSON.stringify(json);
    text += ' '.repeat((4 - (text.length % 4)) % 4);
    const head = Buffer.alloc(20);
    const body = Buffer.from(text);
    const rest = src.subarray(20 + length);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + body.length + rest.length, 8);
    head.writeUInt32LE(body.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    const out = Buffer.concat([head, body, rest]);
    const result = await __buildSkinnedNativeGltfImportOpsForTests({
      buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
      assetRef: 'user-imports/native/animated-skin.glb',
      sceneNodeId: 'n_scene',
      storeImage: async () => 'img',
    });
    if ('refused' in result) throw new Error(result.refused);
    let state = emptyDagState();
    for (const op of result.ops.slice(0, -1)) state = applyOp(state, op).next;
    const modifierId = Object.values(state.nodes).find((n) => n.type === 'ArmatureModifier')!.id;
    const mesh = Object.values(state.nodes).find(
      (n) => (n.inputs.data as { node?: string } | undefined)?.node === modifierId,
    )!;
    expect((parentOf(state, mesh.id)!.params as { position: number[] }).position).toEqual([
      3, 0, 0,
    ]);
    // The node left behind is an empty at the file's (5, 0, 0), and its motion is on it.
    const channel = Object.values(state.nodes).find(
      (n) => n.type === 'KeyframeChannelQuat' && n.id !== mesh.id,
    )!;
    const behind = state.nodes[(channel.params as { target: string }).target];
    expect(behind.type).toBe('Group');
    expect((behind.params as { position: number[] }).position).toEqual([5, 0, 0]);
  });

  it('control: when the mesh node IS the armature node, its transform is kept and nothing is re-skinned', async () => {
    // skinned-bar with its armature/mesh node at (3, 0, 0), turned 45° about Z; Blender (same probe
    // family) puts the corner resting at file (0.2, 2, 0) at world (1.3026, 0.9505, 0) at frame 12.
    const { state, objectId, modifierId } = await imported(
      'public/assets/skinned-bar-moved-armature.glb',
    );
    const object = state.nodes[objectId].params as { position: number[]; quaternion: number[] };
    expect(object.position).toEqual([3, 0, 0]);
    const [x, y, z] = pointAtRest(state, modifierId, [0.2, 2, 0], 0.5);
    const c = Math.SQRT1_2;
    const world = [c * x - c * y + 3, c * x + c * y, z];
    [1.3026, 0.9505, 0].forEach((v, k) => expect(world[k], `axis ${k}`).toBeCloseTo(v, 3));
  });
});

// #393 (step 2) — the Armature modifier deforms a skinned mesh as Blender's does: the oracle is
// Blender 5.1.1 on the same file, and the join rows are Blender's measured behaviour.
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
import type {
  AnimationClipValue,
  BoneSpec,
  MeshGeometryData,
  ModifiedDataValue,
  SkinDeformValue,
} from './types';

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

  it('an armature with no action rests, and no point moves', async () => {
    const { state, modifierId } = await skinnedBar();
    const { skin, mesh } = deformed(state, modifierId);
    expect(Array.from(sampleSkinDeform({ ...skin, action: null }, mesh, 0.5))).toEqual(
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
const TURN: AnimationClipValue = {
  kind: 'AnimationClip',
  name: 'turn',
  duration: 1,
  loop: 'hold',
  keyframes: [
    { bone: 1, time: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    { bone: 1, time: 1, position: [0, 1, 0], rotation: [0, 0, Math.PI / 2] },
  ],
  skeleton: { kind: 'Skeleton', bones: BONES },
};

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
    action: TURN,
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

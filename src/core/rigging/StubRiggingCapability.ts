// StubRiggingCapability — deterministic, dependency-free, offline.
//
// It emits a REAL skinned GLB — joint nodes, a skin, inverse bind matrices, and
// JOINTS_0/WEIGHTS_0 on the primitive — rather than a placeholder. A stub that
// returned a token would let every test below pass while proving nothing about
// whether a rigged mesh can travel the import road, which is the one claim this
// phase makes. Same reasoning, and the same shape, as the motion stub emitting
// real BVH.
//
// 🔴 WHAT THIS STUB DOES AND DOES NOT PROVE, because the distinction decides how
// much the green tick is worth:
//
//   PROVED HERE (offline): a rig capability returns a skinned GLB that Basher's
//   existing import road accepts, carrying a skeleton a retargeted generated clip
//   can bind to.
//
//   PROVED SEPARATELY, against a real asset: that the 22 bones the `somaToMixamo`
//   retarget targets actually exist in a Mixamo rig. Measured against
//   `public/assets/mixamo-xbot.glb` — a genuine Adobe export, 67 joints — and all
//   22 are present. That measurement is what keeps this stub from being circular:
//   the vocabulary claim rests on the real file, not on a fixture written to
//   satisfy the test.
//
//   NOT PROVABLE OFFLINE: that Tripo's `spec: mixamo` emits that vocabulary. No
//   fixture can settle what a service returns. So it is not asserted — it is
//   CHECKED AT RUNTIME on whatever comes back, by `missingForRetarget`, which
//   names the absent bones instead of discovering the gap as a rig that silently
//   animates nothing.
//
// REF: src/core/modelgen/StubModelGenerationCapability.ts (the GLB writer this
//      mirrors); src/core/import/boneNameMaps.ts; issue #795.

import { repackGlb } from '../import/glb';
import {
  DEFAULT_RIG_SPEC,
  assertValidRigRequest,
  type RiggableCheck,
  type RigRequest,
  type RigResult,
  type RigSubject,
  type RiggingCapability,
} from './RiggingCapability';

/**
 * The Mixamo bones this stub rigs to.
 *
 * A SUBSET of a real Mixamo rig, not an invention: measured against
 * `public/assets/mixamo-xbot.glb`, which carries 67 joints named `mixamorig:*`,
 * and every name below is one of them. Adobe writes a COLON; this repo sanitises
 * it to an underscore at import because THREE's PropertyBinding fails silently on
 * the reserved set, so the sanitised form is what a skeleton looks like by the
 * time anything here sees it.
 *
 * Parent index, then name — the hierarchy matters, because a retarget composes
 * through it rather than matching names in a flat list.
 */
const MIXAMO_CORE: readonly (readonly [number, string])[] = [
  [-1, 'mixamorig_Hips'],
  [0, 'mixamorig_Spine'],
  [1, 'mixamorig_Spine1'],
  [2, 'mixamorig_Spine2'],
  [3, 'mixamorig_Neck'],
  [4, 'mixamorig_Head'],
  [3, 'mixamorig_LeftShoulder'],
  [6, 'mixamorig_LeftArm'],
  [7, 'mixamorig_LeftForeArm'],
  [8, 'mixamorig_LeftHand'],
  [3, 'mixamorig_RightShoulder'],
  [10, 'mixamorig_RightArm'],
  [11, 'mixamorig_RightForeArm'],
  [12, 'mixamorig_RightHand'],
  [0, 'mixamorig_LeftUpLeg'],
  [14, 'mixamorig_LeftLeg'],
  [15, 'mixamorig_LeftFoot'],
  [16, 'mixamorig_LeftToeBase'],
  [0, 'mixamorig_RightUpLeg'],
  [18, 'mixamorig_RightLeg'],
  [19, 'mixamorig_RightFoot'],
  [20, 'mixamorig_RightToeBase'],
];

/** Local rest translation per joint, in METRES — a roughly human standing figure.
 *  Only the hierarchy and the names are load-bearing downstream; these keep the
 *  rig at a plausible scale so a size check over it means something. */
const REST: readonly (readonly [number, number, number])[] = [
  [0, 1.0, 0], // Hips, at standing pelvis height
  [0, 0.1, 0],
  [0, 0.12, 0],
  [0, 0.12, 0],
  [0, 0.1, 0],
  [0, 0.12, 0],
  [0.06, 0.08, 0],
  [0.14, 0, 0],
  [0.26, 0, 0],
  [0.24, 0, 0],
  [-0.06, 0.08, 0],
  [-0.14, 0, 0],
  [-0.26, 0, 0],
  [-0.24, 0, 0],
  [0.09, -0.06, 0],
  [0, -0.42, 0],
  [0, -0.4, 0],
  [0, -0.06, 0.14],
  [-0.09, -0.06, 0],
  [0, -0.42, 0],
  [0, -0.4, 0],
  [0, -0.06, 0.14],
];

/** The bone names this stub's rigs carry, in skin order. Exported so a test can
 *  assert against the names rather than re-deriving them. */
export const STUB_RIG_BONES: readonly string[] = MIXAMO_CORE.map(([, name]) => name);

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** World rest position per joint, by walking parents. Needed for the inverse bind
 *  matrices, which are world-space by definition (glTF 2.0 §3.7.3.2). */
function worldRest(): [number, number, number][] {
  const out: [number, number, number][] = [];
  MIXAMO_CORE.forEach(([parent], i) => {
    const p = parent >= 0 ? out[parent] : [0, 0, 0];
    out[i] = [p[0] + REST[i][0], p[1] + REST[i][1], p[2] + REST[i][2]];
  });
  return out;
}

/**
 * Build a skinned GLB carrying a Mixamo-named skeleton.
 *
 * Exported so a test can assert the bytes the capability returns are the bytes
 * this builds — the stub's own claim, checked rather than assumed.
 */
export function synthesiseRiggedGlb(): ArrayBuffer {
  const world = worldRest();
  const joints = MIXAMO_CORE.length;

  // A tall box standing on the floor — enough surface to skin, small enough to read.
  const [hw, hh, hd] = [0.25, 0.9, 0.15];
  const corners: [number, number, number][] = [
    [-hw, 0, -hd],
    [hw, 0, -hd],
    [hw, 2 * hh, -hd],
    [-hw, 2 * hh, -hd],
    [-hw, 0, hd],
    [hw, 0, hd],
    [hw, 2 * hh, hd],
    [-hw, 2 * hh, hd],
  ];
  const tris = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4,
    7, 0, 7, 3,
  ];

  const positions = new Float32Array(corners.flat());
  const indices = new Uint16Array(tris);
  // Every vertex fully weighted to the hip. A real rig distributes; this one only
  // has to be a VALID skin, and a valid skin with one influence is still a skin.
  const jointIdx = new Uint16Array(corners.length * 4);
  const weights = new Float32Array(corners.length * 4);
  for (let v = 0; v < corners.length; v += 1) weights[v * 4] = 1;

  // Inverse bind matrix = inverse of the joint's world rest transform. Rest is
  // translation-only here, so the inverse is a negated translation.
  const ibm = new Float32Array(joints * 16);
  for (let j = 0; j < joints; j += 1) {
    const m = ibm.subarray(j * 16, j * 16 + 16);
    m[0] = m[5] = m[10] = m[15] = 1; // column-major identity
    m[12] = -world[j][0];
    m[13] = -world[j][1];
    m[14] = -world[j][2];
  }

  // glTF 2.0 §3.6.2.4: a bufferView's byteOffset must be a multiple of its
  // component size. Laid out largest-alignment first so every offset falls right.
  const views: { bytes: Uint8Array; offset: number }[] = [];
  let cursor = 0;
  const push = (b: Uint8Array): number => {
    cursor = align4(cursor);
    views.push({ bytes: b, offset: cursor });
    cursor += b.byteLength;
    return views.length - 1;
  };
  const u8 = (a: Float32Array | Uint16Array) =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vPos = push(u8(positions));
  const vIbm = push(u8(ibm));
  const vWeights = push(u8(weights));
  const vJoints = push(u8(jointIdx));
  const vIdx = push(u8(indices));

  const total = align4(cursor);
  const bin = new Uint8Array(total);
  for (const v of views) bin.set(v.bytes, v.offset);

  // Node layout: 0 = the skinned mesh, 1..joints = the skeleton.
  const nodes: Record<string, unknown>[] = [{ mesh: 0, skin: 0, name: 'rigged' }];
  MIXAMO_CORE.forEach(([parent, name], i) => {
    const children = MIXAMO_CORE.map(([p], k) => (p === i ? k + 1 : -1)).filter((k) => k > 0);
    const node: Record<string, unknown> = { name, translation: [...REST[i]] };
    if (children.length > 0) node.children = children;
    void parent;
    nodes.push(node);
  });

  const json = {
    asset: { version: '2.0', generator: 'basher-stub-rigging' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes,
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, JOINTS_0: 3, WEIGHTS_0: 2 },
            indices: 4,
          },
        ],
      },
    ],
    skins: [
      {
        inverseBindMatrices: 1,
        skeleton: 1,
        joints: MIXAMO_CORE.map((_, i) => i + 1),
      },
    ],
    accessors: [
      {
        bufferView: vPos,
        componentType: 5126,
        count: corners.length,
        type: 'VEC3',
        min: [-hw, 0, -hd],
        max: [hw, 2 * hh, hd],
      },
      { bufferView: vIbm, componentType: 5126, count: joints, type: 'MAT4' },
      { bufferView: vWeights, componentType: 5126, count: corners.length, type: 'VEC4' },
      {
        bufferView: vJoints,
        componentType: 5123,
        count: corners.length,
        type: 'VEC4',
      },
      { bufferView: vIdx, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: views.map((v) => ({
      buffer: 0,
      byteOffset: v.offset,
      byteLength: v.bytes.byteLength,
    })),
    buffers: [{ byteLength: total }],
  };

  const bytes = repackGlb({ json, bin });
  // Detach a plain, non-shared ArrayBuffer, the same concern importGltf handles.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class StubRiggingCapability implements RiggingCapability {
  readonly id = 'stub-rigging';
  readonly kind = 'stub' as const;
  private counter = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async checkRiggable(subject: RigSubject): Promise<RiggableCheck> {
    this.counter += 1;
    return {
      taskId: `stub-rigcheck-${this.counter}`,
      riggable: subject.sourceTaskId.trim().length > 0,
      // The stub does not inspect geometry, so it does not KNOW a body plan. It
      // says so rather than answering `biped`, which would be a guess wearing the
      // shape of a measurement.
      detectedRigType: null,
    };
  }

  async rig(request: RigRequest): Promise<RigResult> {
    assertValidRigRequest(request);
    this.counter += 1;
    return {
      taskId: `stub-rig-${this.counter}`,
      glb: synthesiseRiggedGlb(),
      requestedSpec: request.spec ?? DEFAULT_RIG_SPEC,
    };
  }

  async cancel(): Promise<void> {
    // Nothing to cancel — rigging is synchronous and local.
  }
}

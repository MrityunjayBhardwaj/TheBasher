// boneShape — pure geometry for the armature helper (#972, epic #971).
//
// WHY NOT THREE.SkeletonHelper: it extends LineSegments and reads each bone
// with `setFromMatrixPosition` (node_modules/three/src/helpers/SkeletonHelper.js:14,78,82)
// — position only, orientation discarded. A bone rolled about its own axis
// draws identically. Roll is exactly the defect the retarget cluster is about
// (#854, #960), so a line helper would render a wrong rig as correct. This
// module exists to make roll VISIBLE.
//
// The shape is Blender's octahedral bone, read from Blender's source at the
// tag of the build we measured against (5.1.1) rather than guessed — see
// ref/GROUND_TRUTH_BLENDER_ARMATURE_DISPLAY.md, which cites every number below.
//
// Pure + unit-testable in the CameraHelpers.tsx way (V8: this file renders
// nothing and touches no store).

import * as THREE from 'three';
import type { BoneSpec } from '../nodes/types';

// ---------------------------------------------------------------------------
// The shape, in normalised bone space: head at the origin, tail at (0,1,0).
// ---------------------------------------------------------------------------

/**
 * Blender's `bone_octahedral_verts`, verbatim.
 * REF: source/blender/draw/engines/overlay/overlay_shape.cc:96-101 @ v5.1.1
 *
 * v0 is the head, v5 the tail; v1..v4 are the ring at y = 0.1 — 10% of the
 * bone length from the head — an AXIS-ALIGNED SQUARE of half-side 0.1 in XZ.
 */
export const OCTAHEDRAL_VERTS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0], // v0 head
  [0.1, 0.1, 0.1], // v1 ┐
  [0.1, 0.1, -0.1], // v2 │ the ring
  [-0.1, 0.1, -0.1], // v3 │
  [-0.1, 0.1, 0.1], // v4 ┘
  [0.0, 1.0, 0.0], // v5 tail
];

/**
 * `bone_octahedral_solid_tris` — 4 head-fan + 4 tail-fan faces.
 * REF: overlay_shape.cc:120-131 @ v5.1.1
 */
export const OCTAHEDRAL_SOLID_TRIS: ReadonlyArray<readonly [number, number, number]> = [
  [2, 1, 0], // bottom (head cone)
  [3, 2, 0],
  [4, 3, 0],
  [1, 4, 0],
  [5, 1, 2], // top (tail cone)
  [5, 2, 3],
  [5, 3, 4],
  [5, 4, 1],
];

/**
 * `bone_octahedral_wire_lines` — the 12 silhouette edges.
 * REF: overlay_shape.cc:105-118 @ v5.1.1
 */
export const OCTAHEDRAL_WIRE_LINES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 5],
  [5, 3],
  [3, 0],
  [0, 4],
  [4, 5],
  [5, 2],
  [2, 0],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 1],
];

/** Flat [x,y,z, ...] positions for the 6 unit-bone vertices. */
export function octahedralPositions(): number[] {
  return OCTAHEDRAL_VERTS.flatMap((v) => [v[0], v[1], v[2]]);
}

/** Flat triangle indices (8 faces × 3). */
export function octahedralIndices(): number[] {
  return OCTAHEDRAL_SOLID_TRIS.flatMap((t) => [t[0], t[1], t[2]]);
}

/** Flat [x,y,z, x,y,z, ...] LineSegments point PAIRS for the 12 wire edges. */
export function octahedralWireSegments(): number[] {
  const out: number[] = [];
  for (const [a, b] of OCTAHEDRAL_WIRE_LINES) {
    out.push(...OCTAHEDRAL_VERTS[a], ...OCTAHEDRAL_VERTS[b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-bone placement
// ---------------------------------------------------------------------------

/**
 * Leaf-bone length, as a fraction of the parent bone's length.
 *
 * 🔴 This is OURS, and is deliberately NOT attributed to Blender. #971's D2
 * proposed measuring `k` against Blender; measured, Blender has no `k` — its
 * BVH importer manufactures a leaf tail with a flat absolute constant,
 * `global_scale / 10` (scripts/addons_core/io_anim_bvh/import_bvh.py:329-332),
 * and every one of the 16 leaves on our own clip came out at 0.1 with a 4x
 * spread in ratio-to-parent. An absolute constant is not transferable here
 * because one session draws rigs at two scales — metre-scale glTF and
 * centimetre-scale BVH (bone lengths 0.1 … 100 on that same clip) — so it
 * would be invisible on one and enormous on the other.
 *
 * Kept SMALL on purpose: the leaves are HeadEnd/Jaw/eyes/finger-tips/toe-tips,
 * cosmetic tips rather than chain members, and Blender's own rendering of them
 * is near-invisible. Validated by eye against the reference render, not derived.
 */
export const LEAF_LENGTH_RATIO = 0.25;

/** Fallback length for a rig whose bones are ALL degenerate (no scale to borrow). */
const DEGENERATE_FALLBACK_LENGTH = 0.1;

/** Placement input: a bone's identity, its parent, and its WORLD matrix —
 *  whether that came from DAG params or from a live three.js `Bone`. */
export interface BoneWorld {
  readonly name: string;
  /** Parent index into the same array, or -1 for a root. */
  readonly parent: number;
  readonly matrix: THREE.Matrix4;
}

/** One bone, placed in world space and ready to instance. */
export interface BoneFrame {
  readonly name: string;
  readonly index: number;
  readonly head: readonly [number, number, number];
  readonly tail: readonly [number, number, number];
  readonly length: number;
  /** True when the bone has no children and its tail was manufactured. */
  readonly isLeaf: boolean;
  /**
   * The instance matrix: the unit shape above, oriented so +Y runs head→tail,
   * rolled by the bone's own basis, and scaled UNIFORMLY by length.
   */
  readonly matrix: THREE.Matrix4;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/**
 * World-space matrix per bone, composed down the parent chain from the
 * bind-pose TRS. `rotation` is DEGREES in DAG storage (src/viewport/rotation.ts,
 * H20) and Euler order is three.js' default XYZ, matching how SceneFromDAG
 * writes bone TRS onto the live objects.
 *
 * Tolerates a child listed before its parent, and a malformed parent index,
 * without throwing — a bad rig must draw wrong, never crash the viewport.
 */
export function boneWorldMatrices(bones: readonly BoneSpec[]): THREE.Matrix4[] {
  const out: (THREE.Matrix4 | null)[] = bones.map(() => null);

  const local = (i: number): THREE.Matrix4 => {
    const b = bones[i];
    _v.set(b.position[0], b.position[1], b.position[2]);
    _e.set(
      THREE.MathUtils.degToRad(b.rotation[0]),
      THREE.MathUtils.degToRad(b.rotation[1]),
      THREE.MathUtils.degToRad(b.rotation[2]),
      'XYZ',
    );
    _q.setFromEuler(_e);
    const sc = b.scale;
    _s.set(sc ? sc[0] : 1, sc ? sc[1] : 1, sc ? sc[2] : 1);
    return new THREE.Matrix4().compose(_v, _q, _s);
  };

  // Iterative resolve with an explicit visiting set, so a cycle or a
  // forward reference degrades to "treat as root" instead of recursing forever.
  const resolve = (start: number): THREE.Matrix4 => {
    const chain: number[] = [];
    const onPath = new Set<number>();
    let i = start;
    for (;;) {
      if (out[i]) break;
      if (onPath.has(i)) {
        // Cycle: cut it here and treat this bone as a root.
        out[i] = local(i);
        break;
      }
      onPath.add(i);
      chain.push(i);
      const p = bones[i].parent;
      if (p < 0 || p >= bones.length || p === i) {
        out[i] = local(i);
        break;
      }
      i = p;
    }
    // Walk back down, composing parent × local.
    for (let k = chain.length - 1; k >= 0; k--) {
      const j = chain[k];
      if (out[j]) continue;
      const p = bones[j].parent;
      const parentMat = p >= 0 && p < bones.length ? out[p] : null;
      out[j] = parentMat ? new THREE.Matrix4().multiplyMatrices(parentMat, local(j)) : local(j);
    }
    return out[start] as THREE.Matrix4;
  };

  for (let i = 0; i < bones.length; i++) resolve(i);
  return out.map((m, i) => m ?? local(i));
}

/**
 * Place every bone: head, tail, and the instance matrix for the unit shape.
 *
 * 🔑 THE ONE DESIGN DECISION. The octahedron's +Y runs head→tail so it points
 * at the child (Blender bones are head/tail/roll by construction, so their Y IS
 * head→tail — `import_bvh.py:321-327` even AVERAGES multiple children's heads
 * to pick the tail, which is what `tail` does below). Ours are position+rotation
 * joints, where the local Y need not point anywhere in particular; so the
 * head→tail axis is taken from the hierarchy and the ROLL ABOUT IT is taken
 * from the bone's own world basis, by projecting its X axis perpendicular to Y.
 *
 * That projection is the entire point. Rotation about head→tail is exactly the
 * degree of freedom that moves no joint position, hence exactly what
 * SkeletonHelper cannot see and what the retarget gets wrong. Take X from a
 * world-fixed reference instead and roll vanishes — that is the failure this
 * helper exists to avoid.
 *
 * ⚠️ Roll reads MODULO 90°: the ring is a square, so it maps onto itself under a
 * quarter turn. A 90/180/270° roll error is invisible on this shape (in Blender
 * too — same table). The retarget errors we are chasing are 30-68°, well inside
 * one quadrant, but a falsification test MUST use a non-multiple of 90°.
 */
export function placeBones(bones: readonly BoneWorld[]): BoneFrame[] {
  const heads = bones.map((b) => new THREE.Vector3().setFromMatrixPosition(b.matrix));

  // Children per bone, in index order (stable, so the averaged tail is stable).
  const children: number[][] = bones.map(() => []);
  for (let i = 0; i < bones.length; i++) {
    const p = bones[i].parent;
    if (p >= 0 && p < bones.length && p !== i) children[p].push(i);
  }

  // Pass 1 — the tail every non-leaf bone gets from its children.
  const tails: (THREE.Vector3 | null)[] = bones.map(() => null);
  for (let i = 0; i < bones.length; i++) {
    const kids = children[i];
    if (kids.length === 0) continue;
    const t = new THREE.Vector3();
    for (const k of kids) t.add(heads[k]);
    t.multiplyScalar(1 / kids.length);
    if (t.distanceTo(heads[i]) > 1e-9) tails[i] = t;
  }

  // A scale to fall back on when a leaf's parent is itself degenerate.
  const known = tails.map((t, i) => (t ? t.distanceTo(heads[i]) : 0)).filter((l) => l > 0);
  const meanLength =
    known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : DEGENERATE_FALLBACK_LENGTH;

  // Pass 2 — manufacture a tail for leaves (and for degenerate non-leaves),
  // continuing the parent's direction. See LEAF_LENGTH_RATIO for why the
  // magnitude is relative and why it is not Blender's.
  const dirOf = (i: number): THREE.Vector3 => {
    const p = bones[i].parent;
    if (p >= 0 && p < bones.length && tails[p]) {
      const d = tails[p]!.clone().sub(heads[p]);
      if (d.lengthSq() > 1e-18) return d.normalize();
    }
    // No usable parent direction: use the bone's own +Y, then world +Y.
    const y = new THREE.Vector3().setFromMatrixColumn(bones[i].matrix, 1);
    if (y.lengthSq() > 1e-18) return y.normalize();
    return new THREE.Vector3(0, 1, 0);
  };

  const frames: BoneFrame[] = [];
  for (let i = 0; i < bones.length; i++) {
    const isLeaf = children[i].length === 0;
    let tail = tails[i];
    if (!tail) {
      const p = bones[i].parent;
      const parentLen =
        p >= 0 && p < bones.length && tails[p] ? tails[p]!.distanceTo(heads[p]) : meanLength;
      const len = Math.max(parentLen * LEAF_LENGTH_RATIO, 1e-6);
      tail = heads[i].clone().addScaledVector(dirOf(i), len);
    }

    const head = heads[i];
    const yAxis = tail.clone().sub(head);
    const length = yAxis.length();
    yAxis.multiplyScalar(1 / (length || 1));

    // Roll: the bone's own X, projected perpendicular to the head→tail axis.
    const xAxis = new THREE.Vector3().setFromMatrixColumn(bones[i].matrix, 0);
    xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis));
    if (xAxis.lengthSq() < 1e-12) {
      // Degenerate (bone X parallel to head→tail): any perpendicular will do —
      // roll is genuinely unrecoverable for this bone, so pick deterministically.
      const seed =
        Math.abs(yAxis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      xAxis.copy(seed).addScaledVector(yAxis, -seed.dot(yAxis));
    }
    xAxis.normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();

    // Uniform scale by length on all three axes — Blender's
    // `copy_v3_fl(bone_scale, length)` + `rescale_m4`
    // (overlay_armature.cc:970-983). A longer bone is drawn proportionally wider.
    const s = length > 0 ? length : DEGENERATE_FALLBACK_LENGTH;
    const matrix = new THREE.Matrix4().set(
      xAxis.x * s,
      yAxis.x * s,
      zAxis.x * s,
      head.x,
      xAxis.y * s,
      yAxis.y * s,
      zAxis.y * s,
      head.y,
      xAxis.z * s,
      yAxis.z * s,
      zAxis.z * s,
      head.z,
      0,
      0,
      0,
      1,
    );

    frames.push({
      name: bones[i].name,
      index: i,
      head: [head.x, head.y, head.z],
      tail: [tail.x, tail.y, tail.z],
      length,
      isLeaf,
      matrix,
    });
  }
  return frames;
}

/**
 * Re-express a `BoneSpec` skeleton (DAG params, bind pose) as placement input.
 *
 * The other producer is the LIVE three.js rig: `GltfSkeleton.evaluate` returns
 * the bind pose captured at import (GltfSkeleton.ts:48-53, no time argument),
 * so the ANIMATED pose exists only as `Bone` objects written per frame by the
 * useFrame in SceneFromDAG. Those feed `placeBones` directly through their
 * `matrixWorld` — same core, same roll handling, no second implementation.
 */
export function boneTransforms(bones: readonly BoneSpec[]): BoneFrame[] {
  const world = boneWorldMatrices(bones);
  return placeBones(bones.map((b, i) => ({ name: b.name, parent: b.parent, matrix: world[i] })));
}

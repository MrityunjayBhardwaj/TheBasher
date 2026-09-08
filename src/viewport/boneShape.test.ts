// boneShape — pure octahedral bone geometry for the #972 armature helper.
//
// The load-bearing rows are the ROLL ones. Everything else here is arithmetic;
// "a roll changes the drawing, and a position-only witness cannot see it" is the
// reason this module exists instead of THREE.SkeletonHelper.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneSpec } from '../nodes/types';
import {
  LEAF_LENGTH_RATIO,
  OCTAHEDRAL_SOLID_TRIS,
  OCTAHEDRAL_VERTS,
  OCTAHEDRAL_WIRE_LINES,
  boneTransforms,
  boneWorldMatrices,
  octahedralIndices,
  octahedralPositions,
  octahedralWireSegments,
} from './boneShape';

/** The 6 unit-shape vertices put through a bone matrix, rounded and sorted —
 *  i.e. what the eye actually sees, independent of vertex ORDER. */
function drawnPoints(m: THREE.Matrix4): string[] {
  return OCTAHEDRAL_VERTS.map((v) => {
    const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
    return [p.x, p.y, p.z].map((n) => n.toFixed(4)).join(',');
  }).sort();
}

/** root → child at +Y, so head→tail is +Y and a Y-rotation is a pure roll. */
function twoBoneRig(rootRotationDeg: [number, number, number]): BoneSpec[] {
  return [
    { name: 'root', parent: -1, position: [0, 0, 0], rotation: rootRotationDeg },
    { name: 'child', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
  ];
}

describe('the octahedral tables (Blender v5.1.1, overlay_shape.cc)', () => {
  it('is 6 verts, 8 tris, 12 wire edges', () => {
    expect(OCTAHEDRAL_VERTS.length).toBe(6);
    expect(OCTAHEDRAL_SOLID_TRIS.length).toBe(8);
    expect(OCTAHEDRAL_WIRE_LINES.length).toBe(12);
    expect(octahedralPositions().length).toBe(6 * 3);
    expect(octahedralIndices().length).toBe(8 * 3);
    expect(octahedralWireSegments().length).toBe(12 * 2 * 3);
  });

  it('runs head(0,0,0) → tail(0,1,0) along +Y', () => {
    expect(OCTAHEDRAL_VERTS[0]).toEqual([0, 0, 0]);
    expect(OCTAHEDRAL_VERTS[5]).toEqual([0, 1, 0]);
  });

  it('puts the ring at 10% of the length, as a square of half-side 0.1', () => {
    const ring = OCTAHEDRAL_VERTS.slice(1, 5);
    for (const v of ring) {
      expect(v[1]).toBeCloseTo(0.1);
      expect(Math.abs(v[0])).toBeCloseTo(0.1);
      expect(Math.abs(v[2])).toBeCloseTo(0.1);
    }
    // All four corners, no duplicates.
    expect(new Set(ring.map((v) => `${v[0]},${v[2]}`)).size).toBe(4);
  });

  it('every index is in range', () => {
    for (const i of [...octahedralIndices(), ...OCTAHEDRAL_WIRE_LINES.flat()]) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(6);
    }
  });
});

describe('boneWorldMatrices', () => {
  it('composes translation down the parent chain', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [1, 0, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 2, 0], rotation: [0, 0, 0] },
      { name: 'c', parent: 1, position: [0, 0, 3], rotation: [0, 0, 0] },
    ];
    const p = boneWorldMatrices(bones).map((m) =>
      new THREE.Vector3().setFromMatrixPosition(m).toArray(),
    );
    expect(p[0]).toEqual([1, 0, 0]);
    expect(p[1]).toEqual([1, 2, 0]);
    expect(p[2]).toEqual([1, 2, 3]);
  });

  it('reads rotation as DEGREES (H20 — DAG storage is degrees)', () => {
    // 90° about Z takes the child's local +Y offset onto world -X.
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 90] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const p = new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[1]);
    expect(p.x).toBeCloseTo(-1);
    expect(p.y).toBeCloseTo(0);
  });

  it('applies optional bind scale, defaulting to 1', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    expect(new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[1]).y).toBeCloseTo(2);
  });

  it('survives a child listed before its parent', () => {
    const bones: BoneSpec[] = [
      { name: 'child', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'root', parent: -1, position: [5, 0, 0], rotation: [0, 0, 0] },
    ];
    expect(
      new THREE.Vector3().setFromMatrixPosition(boneWorldMatrices(bones)[0]).toArray(),
    ).toEqual([5, 1, 0]);
  });

  it('does not hang on a parent cycle or an out-of-range parent', () => {
    const cyclic: BoneSpec[] = [
      { name: 'a', parent: 1, position: [0, 1, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 1, 0], rotation: [0, 0, 0] },
    ];
    const bad: BoneSpec[] = [{ name: 'a', parent: 99, position: [0, 1, 0], rotation: [0, 0, 0] }];
    for (const rig of [cyclic, bad]) {
      const ms = boneWorldMatrices(rig);
      expect(ms.length).toBe(rig.length);
      expect(ms.every((m) => m.elements.every((n) => Number.isFinite(n)))).toBe(true);
    }
  });
});

describe('boneTransforms — placement', () => {
  it("takes a bone's tail from its child's head", () => {
    const [root] = boneTransforms(twoBoneRig([0, 0, 0]));
    expect(root.tail).toEqual([0, 1, 0]);
    expect(root.length).toBeCloseTo(1);
    expect(root.isLeaf).toBe(false);
  });

  it('averages multiple children (Blender import_bvh.py:321-327)', () => {
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'l', parent: 0, position: [-1, 2, 0], rotation: [0, 0, 0] },
      { name: 'r', parent: 0, position: [1, 2, 0], rotation: [0, 0, 0] },
    ];
    expect(boneTransforms(bones)[0].tail).toEqual([0, 2, 0]);
  });

  it('scales the shape UNIFORMLY by length (overlay_armature.cc:970-983)', () => {
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'child', parent: 0, position: [0, 4, 0], rotation: [0, 0, 0] },
    ];
    const m = boneTransforms(bones)[0].matrix;
    const basis = [0, 1, 2].map((c) => new THREE.Vector3().setFromMatrixColumn(m, c).length());
    // A 4-long bone is 4x wider too — not just 4x longer.
    basis.forEach((len) => expect(len).toBeCloseTo(4));
  });

  it('manufactures a leaf tail at LEAF_LENGTH_RATIO of the parent, continuing its direction', () => {
    const frames = boneTransforms(twoBoneRig([0, 0, 0]));
    const leaf = frames[1];
    expect(leaf.isLeaf).toBe(true);
    // Parent runs +Y with length 1, so the leaf continues +Y at the ratio.
    expect(leaf.length).toBeCloseTo(LEAF_LENGTH_RATIO);
    expect(leaf.tail[1]).toBeCloseTo(1 + LEAF_LENGTH_RATIO);
  });

  it('yields finite matrices for a single degenerate bone', () => {
    const lone: BoneSpec[] = [{ name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }];
    const f = boneTransforms(lone)[0];
    expect(f.matrix.elements.every((n) => Number.isFinite(n))).toBe(true);
    expect(f.length).toBeGreaterThan(0);
  });

  it('does not collapse when a parent and child share a position', () => {
    const bones: BoneSpec[] = [
      { name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'b', parent: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    ];
    const frames = boneTransforms(bones);
    expect(frames.every((f) => f.matrix.elements.every((n) => Number.isFinite(n)))).toBe(true);
    expect(frames.every((f) => f.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rows this module exists for.
// ---------------------------------------------------------------------------

describe('boneTransforms — roll is visible (the reason SkeletonHelper is disqualified)', () => {
  it('a 45° roll changes the drawing while every joint POSITION stays put', () => {
    const straight = boneTransforms(twoBoneRig([0, 0, 0]));
    const rolled = boneTransforms(twoBoneRig([0, 45, 0]));

    // The position-only witness — SkeletonHelper's `setFromMatrixPosition` — is
    // blind here: heads and tails are identical to the last decimal. V427.
    straight.forEach((f, i) => {
      f.head.forEach((n, k) => expect(n).toBeCloseTo(rolled[i].head[k], 6));
      f.tail.forEach((n, k) => expect(n).toBeCloseTo(rolled[i].tail[k], 6));
    });

    // Ours is not.
    expect(drawnPoints(rolled[0].matrix)).not.toEqual(drawnPoints(straight[0].matrix));
  });

  it('roll survives as an actual 45° turn of the ring, not just any difference', () => {
    const straight = boneTransforms(twoBoneRig([0, 0, 0]))[0];
    const rolled = boneTransforms(twoBoneRig([0, 45, 0]))[0];
    // Ring vertex v1 sits at local (0.1, 0.1, 0.1). Its angle about the bone's
    // +Y axis must have moved by exactly the roll we applied.
    const ringOf = (m: THREE.Matrix4) => {
      const v = OCTAHEDRAL_VERTS[1];
      const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
      return Math.atan2(p.z, p.x);
    };
    let d = THREE.MathUtils.radToDeg(ringOf(rolled.matrix) - ringOf(straight.matrix));
    d = ((d % 360) + 360) % 360;
    expect(Math.min(d, 360 - d)).toBeCloseTo(45, 3);
  });

  it('DOCUMENTED LIMIT: a 90° roll is invisible — the ring is a square', () => {
    // Not a bug and not a gap in the witness: Blender's own table has the same
    // 4-fold symmetry. It is here so nobody "fixes" a falsification test by
    // reaching for 90/180/270 and concludes the helper is roll-blind.
    const straight = boneTransforms(twoBoneRig([0, 0, 0]))[0];
    const quarter = boneTransforms(twoBoneRig([0, 90, 0]))[0];
    expect(drawnPoints(quarter.matrix)).toEqual(drawnPoints(straight.matrix));
  });

  it('the roll comes from the BONE, not from a world-fixed reference', () => {
    // The falsification #972 asks for, as a permanent row: if the X axis were
    // taken from world-up (the naive head→tail-only construction) every one of
    // these rolls would draw identically. Sweep past the 90° symmetry.
    const seen = new Set<string>();
    for (const deg of [0, 15, 30, 45, 60, 75]) {
      seen.add(drawnPoints(boneTransforms(twoBoneRig([0, deg, 0]))[0].matrix).join('|'));
    }
    expect(seen.size).toBe(6);
  });

  it('keeps the octahedron pointing at the child even when the bone axis is not +Y', () => {
    // A joint rig's local +Y need not point down the bone. The shape must still
    // run head→tail — this is the half of the design the roll test cannot pin.
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'child', parent: 0, position: [3, 0, 0], rotation: [0, 0, 0] },
    ];
    const m = boneTransforms(bones)[0].matrix;
    // Local tail (0,1,0) must land on the child's head.
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(m);
    expect(tip.x).toBeCloseTo(3);
    expect(tip.y).toBeCloseTo(0);
    expect(tip.z).toBeCloseTo(0);
  });

  it('stays orthonormal-up-to-scale so the shape is never sheared', () => {
    const m = boneTransforms(twoBoneRig([20, 35, 50]))[0].matrix;
    const [x, y, z] = [0, 1, 2].map((c) => new THREE.Vector3().setFromMatrixColumn(m, c));
    expect(x.dot(y)).toBeCloseTo(0, 6);
    expect(y.dot(z)).toBeCloseTo(0, 6);
    expect(x.dot(z)).toBeCloseTo(0, 6);
    expect(x.length()).toBeCloseTo(y.length(), 6);
    expect(y.length()).toBeCloseTo(z.length(), 6);
  });
});

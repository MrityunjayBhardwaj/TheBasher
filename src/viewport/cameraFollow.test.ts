// What the view centre follows when it is locked (#856).
//
// The rows here state the three answers `followPoint` can give and the order it
// prefers them in. The one worth reading twice is the LAST: a rig's root bone is
// excluded from the point, and if it were not, following a character would drift
// toward wherever the root happens to sit — which on a BVH-driven rig is the
// world origin, not the body.
//
// REF: src/viewport/cameraFollow.ts; src/viewport/referenceRig.ts
//      (`armatureBounds`, whose root exclusion this leans on); issue #856.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { followPoint, type FollowArmature } from './cameraFollow';
import type { BoneFrame } from './boneShape';

/** A bone frame is a name, a parent and two world points; the rest of the shape
 *  is the drawing's business and no part of choosing a point. */
function frame(
  name: string,
  parent: number,
  head: [number, number, number],
  tail: [number, number, number],
): BoneFrame {
  return {
    name,
    index: 0,
    parent,
    head,
    tail,
    length: new THREE.Vector3(...tail).sub(new THREE.Vector3(...head)).length(),
    isLeaf: false,
    matrix: new THREE.Matrix4(),
  };
}

/** A two-bone body standing at x, with a root pinned at the world origin —
 *  the shape a BVH-driven character actually has. */
function walker(x: number): BoneFrame[] {
  return [
    frame('Root', -1, [0, 0, 0], [0, 0, 0]),
    frame('Hips', 0, [x, 1, 0], [x, 1.4, 0]),
    frame('Spine', 1, [x, 1.4, 0], [x, 1.8, 0]),
  ];
}

const rig = (ids: string[], frames: BoneFrame[]): FollowArmature => ({
  ids: new Set(ids),
  frames,
});

describe('followPoint', () => {
  it('follows the rig belonging to a node that is nowhere in the armature itself', () => {
    // The id a director locks with is almost never the one on the armature's
    // ancestors: clicking the body selects a `GltfChild`, the armature's
    // SIBLING. Membership of the asset's id set is the whole join.
    // 🔴 THE OBJECT POINT IS SUPPLIED AND MUST LOSE. In the scene a director
    // actually has, the import group IS named with its node id, so a point for
    // it is always available — and it is the point that does not move. Preferring
    // it is the whole defect this issue reports, so the rows that exercise a rig
    // hand the losing answer in rather than passing null and proving nothing.
    const found = followPoint([rig(['group-1', 'child-7'], walker(2))], 'child-7', null, [0, 0, 0]);
    expect(found?.source).toBe('armature');
    expect(found?.point[0]).toBeCloseTo(2, 6);
  });

  it('follows a named bone in preference to the rig, and follows its HEAD', () => {
    const found = followPoint([rig(['group-1'], walker(2))], 'group-1', 'Spine', [0, 0, 0]);
    expect(found).toEqual({ point: [2, 1.4, 0], source: 'bone', bone: 'Spine' });
  });

  it('falls back to the rig when the named bone is no longer in it', () => {
    // The character is still there and still walking. Refusing to follow it
    // because one bone was renamed would be a worse answer than following the
    // body — and `null` here would read on screen exactly like a dead lock.
    const found = followPoint([rig(['group-1'], walker(2))], 'group-1', 'LeftHand', [0, 0, 0]);
    expect(found?.source).toBe('armature');
  });

  it('follows an ordinary object when no rig claims the node', () => {
    const found = followPoint([rig(['group-1'], walker(2))], 'empty-9', null, [5, 0, -3]);
    expect(found).toEqual({ point: [5, 0, -3], source: 'object', bone: null });
  });

  it('follows the object when the rig that claims the node has no bones', () => {
    const found = followPoint([rig(['group-1'], [])], 'group-1', null, [5, 0, -3]);
    expect(found?.source).toBe('object');
  });

  it('reports null rather than a coordinate nobody authored', () => {
    expect(followPoint([], 'group-1', null, null)).toBeNull();
  });

  it('🔴 does not drag the point toward a root bone pinned at the origin', () => {
    // The defect this row exists for: a rig's transport root sits at the world
    // origin while the body walks away, so a point taken over ALL bones is a
    // function of how far the character has travelled rather than of where it
    // is. Measured on our own clip in #977: the root grew a rig's Z extent from
    // 25 to 238 units across 1.5s while the body never changed size.
    //
    // Falsification: including the root would put x at 1 (halfway to the
    // origin), not at 10.
    const found = followPoint([rig(['g'], walker(10))], 'g', null, [0, 0, 0]);
    expect(found?.point[0]).toBeCloseTo(10, 6);

    // And the point TRAVELS with the body — the property the whole feature is.
    const later = followPoint([rig(['g'], walker(14))], 'g', null, [0, 0, 0]);
    expect((later?.point[0] ?? 0) - (found?.point[0] ?? 0)).toBeCloseTo(4, 6);
  });
});

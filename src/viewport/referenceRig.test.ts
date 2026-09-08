// referenceRig — placing the source rig beside the character it drives (#977).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneSpec } from '../nodes/types';
import { boneTransforms, type BoneFrame } from './boneShape';
import { REFERENCE_GAP_RATIO, armatureBounds, referencePlacement } from './referenceRig';

/** An upright rig of the given height, standing at x.
 *
 *  Shaped like the real thing: a parentless TRANSPORT node, then the anatomy
 *  under it. armatureBounds excludes roots on purpose, so a fixture whose only
 *  non-root bone starts at the top would report a rig floating in mid-air —
 *  which is exactly what the first version of this fixture did. */
function upright(height: number, x = 0): BoneFrame[] {
  const bones: BoneSpec[] = [
    { name: 'root', parent: -1, position: [x, 0, 0], rotation: [0, 0, 0] },
    { name: 'hips', parent: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
    { name: 'head', parent: 1, position: [0, height, 0], rotation: [0, 0, 0] },
  ];
  return boneTransforms(bones);
}

describe('armatureBounds', () => {
  it('spans heads AND tails', () => {
    // The top bone's TAIL is above its head; heads alone would under-report.
    const b = armatureBounds(upright(2));
    expect(b.min.y).toBeCloseTo(0);
    expect(b.max.y).toBeGreaterThan(2);
    expect(b.height).toBeGreaterThan(2);
    expect(b.empty).toBe(false);
  });

  it('reports empty for no bones, without NaN', () => {
    const b = armatureBounds([]);
    expect(b.empty).toBe(true);
    expect(b.height).toBe(0);
    expect([b.min.x, b.max.y, b.center.z, b.size.x].every(Number.isFinite)).toBe(true);
  });
});

describe('referencePlacement', () => {
  it('scales a 100x rig down to the target height', () => {
    // The real case: a centimetre-scale BVH rig against a metre-scale glTF one.
    const source = armatureBounds(upright(180));
    const target = armatureBounds(upright(1.8));
    const m = referencePlacement(source, target);
    const scale = new THREE.Vector3().setFromMatrixColumn(m, 0).length();
    expect(scale).toBeCloseTo(target.height / source.height, 6);
    expect(scale).toBeCloseTo(0.01, 4);
  });

  it('lands the source rig FEET-level with the target, not centre-level', () => {
    // Targets whose feet are at y = 0; a centre-anchored placement would sink
    // the shorter-torsoed rig into the floor.
    const source = armatureBounds(upright(180));
    const target = armatureBounds(upright(1.8));
    const m = referencePlacement(source, target);
    const placed = source.min.clone().applyMatrix4(m);
    expect(placed.y).toBeCloseTo(target.min.y, 6);
  });

  it('stands it clear of the target along +X, never overlapping', () => {
    const source = armatureBounds(upright(180));
    const target = armatureBounds(upright(1.8));
    const m = referencePlacement(source, target);
    const lo = source.min.clone().applyMatrix4(m);
    expect(lo.x).toBeGreaterThan(target.max.x);
    // And the gap is the one we asked for, not an accident of the maths.
    expect(lo.x - target.max.x).toBeCloseTo(target.height * REFERENCE_GAP_RATIO, 4);
  });

  it('follows the target when the character stands somewhere else', () => {
    const source = armatureBounds(upright(180));
    const here = armatureBounds(upright(1.8, 0));
    const there = armatureBounds(upright(1.8, 7));
    const dx =
      source.min.clone().applyMatrix4(referencePlacement(source, there)).x -
      source.min.clone().applyMatrix4(referencePlacement(source, here)).x;
    expect(dx).toBeCloseTo(7, 4);
  });

  it('preserves limb ANGLES — the whole reason the rig is drawn at all', () => {
    // A bone at 30 degrees must still read 30 degrees after normalisation, or
    // the comparison this exists for is measuring the placement.
    const bones: BoneSpec[] = [
      { name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] },
      { name: 'a', parent: 0, position: [0, 0, 0], rotation: [0, 0, 0] },
      {
        name: 'b',
        parent: 1,
        position: [Math.sin(Math.PI / 6) * 50, Math.cos(Math.PI / 6) * 50, 0],
        rotation: [0, 0, 0],
      },
    ];
    const frames = boneTransforms(bones).slice(1);
    const src = armatureBounds(frames);
    const m = referencePlacement(src, armatureBounds(upright(1.8)));
    const dirBefore = new THREE.Vector3(
      frames[0].tail[0] - frames[0].head[0],
      frames[0].tail[1] - frames[0].head[1],
      frames[0].tail[2] - frames[0].head[2],
    ).normalize();
    const h = new THREE.Vector3(...frames[0].head).applyMatrix4(m);
    const t = new THREE.Vector3(...frames[0].tail).applyMatrix4(m);
    const dirAfter = t.sub(h).normalize();
    expect(dirAfter.angleTo(dirBefore)).toBeCloseTo(0, 6);
  });

  it('is identity when either rig is empty, rather than collapsing to a point', () => {
    const real = armatureBounds(upright(1.8));
    const none = armatureBounds([]);
    expect(referencePlacement(none, real).equals(new THREE.Matrix4())).toBe(true);
    expect(referencePlacement(real, none).equals(new THREE.Matrix4())).toBe(true);
  });

  it('does not divide by zero on a rig with no height', () => {
    const flat = armatureBounds([
      ...boneTransforms([{ name: 'a', parent: -1, position: [0, 0, 0], rotation: [0, 0, 0] }]),
    ]);
    const m = referencePlacement(flat, armatureBounds(upright(1.8)));
    expect(m.elements.every(Number.isFinite)).toBe(true);
  });
});

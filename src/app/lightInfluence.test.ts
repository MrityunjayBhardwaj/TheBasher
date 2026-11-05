// #1783 with #1765 — a light's Track-To blends by its influence, like any object's: since #1765 a
// light is turned by its rotation or a Track-To through the same constraint fold, so a light at
// influence 0 shines down its own rotation and one at 0.5 halfway, by slerp. (Before the shared
// fold, a light read only the top member's aim point and aimed fully at any influence.)
//
// The default scene's sun (`n_light`) is aimed by `n_light_aim` at the empty `n_light_target`.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { resolveConstraintRotation } from './nodeConstraints';

type Vec3 = [number, number, number];
const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const OWN: Vec3 = [-30, 20, 0];

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const quatOf = (deg: readonly number[]) =>
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(...(deg.map((d) => THREE.MathUtils.degToRad(d)) as Vec3), 'XYZ'),
  );
const same = (a: THREE.Quaternion, b: THREE.Quaternion) => Math.abs(a.dot(b));

/** The default scene with the sun's own rotation `OWN` and its Track-To at `influence`. */
function sun(influence?: number): DagState {
  let s = applyOp(buildDefaultDagState(), {
    type: 'setParam',
    nodeId: 'n_light',
    paramPath: 'rotation',
    value: OWN,
  }).next;
  if (influence !== undefined)
    s = applyOp(s, {
      type: 'setParam',
      nodeId: 'n_light_aim',
      paramPath: 'influence',
      value: influence,
    }).next;
  return s;
}
/** The sun's turn: its constraint fold's (top-level, so world), else its own rotation. */
const drawn = (s: DagState) => quatOf(resolveConstraintRotation(s, 'n_light', ctx) ?? OWN);

describe('a light blends by its Track-To influence (#1783, #1765)', () => {
  it('the premise: the default sun is aimed by a Track-To, away from its own rotation', () => {
    expect(sun().nodes.n_light_aim?.type).toBe('TrackTo');
    expect(same(drawn(sun()), quatOf(OWN))).toBeLessThan(0.95);
  });

  it('influence 0: the sun shines down its own rotation', () => {
    expect(same(drawn(sun(0)), quatOf(OWN))).toBeCloseTo(1, 9);
  });

  it('influence 0.5: halfway from its own rotation to the aim, by slerp', () => {
    const full = drawn(sun());
    expect(same(drawn(sun(0.5)), quatOf(OWN).slerp(full, 0.5))).toBeCloseTo(1, 9);
  });

  it('influence 1 is exactly the aim it always was', () => {
    const one = resolveConstraintRotation(sun(1), 'n_light', ctx);
    expect(one).not.toBeNull();
    expect(one).toEqual(resolveConstraintRotation(sun(), 'n_light', ctx));
  });
});

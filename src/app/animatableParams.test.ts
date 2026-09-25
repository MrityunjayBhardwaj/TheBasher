// #1235 — the reader of the measured census: subject keys, path patterns, and the three answers.
//
// The census itself is measured by tests/e2e/p1235-animatable-census.spec.ts; these rows pin
// what the lookup does with it, on subjects built by the product's own Add builder.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import { __resetRegistryForTests } from '../core/dag/registry';
import type { DagState } from '../core/dag/state';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { buildAddPrimitiveOps, type PrimitiveKind } from './addPrimitives';
import { buildAddModifierOps } from './operatorStack';
import { buildAddConstraintOps } from './constraintStack';
import { buildBindDriverOps } from './driverBind';
import { buildNewMaterialOps } from './materialLink';
import {
  animatablePathPattern,
  animatablePathsOf,
  animatableSubjectOf,
  isAnimatable,
} from './animatableParams';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function place(state: DagState, kind: PrimitiveKind) {
  const r = buildAddPrimitiveOps(state, kind, [0, 0, 0])!;
  let s = state;
  for (const op of r.ops) s = applyOp(s, op).next;
  return { s, obj: r.newNodeId, data: r.dataNodeId ?? r.newNodeId };
}

describe('animatableSubjectOf — the key the census measured under', () => {
  it('names a data kind by its discriminator, and an Object by the data it poses', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    expect(animatableSubjectOf(spot.s, spot.data)).toBe('LightData:Spot');
    expect(animatableSubjectOf(spot.s, spot.obj)).toBe('Object<LightData:Spot>');
    const cam = place(buildDefaultDagState(), 'OrthographicCamera');
    expect(animatableSubjectOf(cam.s, cam.data)).toBe('CameraData:Orthographic');
    expect(animatableSubjectOf(cam.s, 'no-such-node')).toBeNull();
  });
});

describe('animatablePathPattern', () => {
  it('generalises every array index and leaves names alone', () => {
    expect(animatablePathPattern('points.3.co')).toBe('points.*.co');
    expect(animatablePathPattern('material.base.color')).toBe('material.base.color');
    expect(animatablePathPattern('materials.12.base.color')).toBe('materials.*.base.color');
  });
});

describe('isAnimatable — three answers, never two', () => {
  it('a spot light draws its cone angle; a point light, which has no cone, does not', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const point = place(buildDefaultDagState(), 'PointLight');
    expect(isAnimatable(spot.s, spot.data, 'angle', 'number')).toEqual({
      answer: 'animatable',
      reach: 'scene',
      kind: 'number',
    });
    expect(isAnimatable(point.s, point.data, 'angle', 'number')).toEqual({
      answer: 'still',
      kind: 'number',
    });
  });

  it('a spot light aims by its target, so its Object rotation moves nothing', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    expect(isAnimatable(spot.s, spot.obj, 'rotation', 'vec3').answer).toBe('still');
    expect(isAnimatable(spot.s, spot.obj, 'position', 'vec3').answer).toBe('animatable');
  });

  it('a channel of the wrong kind on a live param is still, and says what kind the param is', () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    expect(isAnimatable(spot.s, spot.data, 'intensity', 'color')).toEqual({
      answer: 'still',
      kind: 'number',
    });
  });

  it("camera near/far reach only the pose the renderer takes; zoom and depth of field don't (#193)", () => {
    const cam = place(buildDefaultDagState(), 'PerspectiveCamera');
    expect(isAnimatable(cam.s, cam.data, 'near', 'number')).toMatchObject({ reach: 'pose' });
    expect(isAnimatable(cam.s, cam.data, 'zoom', 'number').answer).toBe('still');
    expect(isAnimatable(cam.s, cam.data, 'fStop', 'number').answer).toBe('still');
  });

  it("a curve's points do not redraw from a channel (#474), at any index", () => {
    const curve = place(buildDefaultDagState(), 'Curve');
    for (const i of [0, 3, 17])
      expect(isAnimatable(curve.s, curve.data, `points.${i}.co`, 'vec3').answer).toBe('still');
  });

  it('could-not-look is never reported as nothing-moves', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    // Measured nowhere: the harness places no texture, so a uvTransform could not show.
    expect(isAnimatable(cube.s, cube.data, 'material.uvTransform.tiling', 'vec2')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringMatching(/texture/),
    });
    // A subject the census never places: a Shot is a timeline range, not a scene object.
    const s = applyOp(cube.s, {
      type: 'addNode',
      nodeId: 'shot',
      nodeType: 'Shot',
      params: {},
    }).next;
    expect(isAnimatable(s, 'shot', 'endTime', 'number')).toEqual({
      answer: 'unmeasured',
      reason: 'the census places no Shot',
    });
    // A path the census never saw on a subject it did place.
    expect(isAnimatable(cube.s, cube.data, 'nonsense', 'number')).toMatchObject({
      answer: 'unmeasured',
    });
  });
});

describe('a param read raw is measured, and answered still', () => {
  it("a Track-To's fixed aim point is read straight from its params, so a keyframe on it moves nothing", () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const tt = buildAddConstraintOps(cube.s, cube.obj, 'TrackTo')!;
    let s = cube.s;
    for (const op of tt.ops) s = applyOp(s, op).next;
    expect(isAnimatable(s, tt.constraintId, 'aimPoint', 'vec3')).toEqual({
      answer: 'still',
      kind: 'vec3',
    });
  });
});

describe('a data param under an operator stack is not answered for (#1247)', () => {
  it("a Cube's size under a UV Project is unmeasured, and the same Cube bare is animatable", () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    expect(isAnimatable(cube.s, cube.data, 'size', 'vec3').answer).toBe('animatable');
    const mod = buildAddModifierOps(cube.s, cube.data, 'UVProjectModifier')!;
    let s = cube.s;
    for (const op of mod.ops) s = applyOp(s, op).next;
    expect(isAnimatable(s, cube.data, 'size', 'vec3')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringMatching(/UVProjectModifier.*#1247/),
    });
    expect(animatablePathsOf(s, cube.data, 'vec3')).toBeNull();
  });
});

describe('a param something else supplies is unmeasured here, not still', () => {
  const apply = (st: DagState, ops: readonly Parameters<typeof applyOp>[1][]) => {
    let n = st;
    for (const op of ops) n = applyOp(n, op).next;
    return n;
  };

  it("a linked Material owns the cube's colour, so the cube's own row is not answered for", () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    expect(isAnimatable(cube.s, cube.data, 'material.base.color', 'color').answer).toBe(
      'animatable',
    );
    const mat = buildNewMaterialOps(cube.s, cube.data)!;
    const s = apply(cube.s, mat.ops);
    expect(isAnimatable(s, cube.data, 'material.base.color', 'color')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringContaining(`${mat.materialNodeId}.material.base.color supplies it`),
    });
    expect(animatablePathsOf(s, cube.data, 'color')).not.toContain('material.base.color');
  });

  it('a Follow-Path places the object, so its position is not answered for; its scale still is', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    const s = apply(cube.s, buildAddConstraintOps(cube.s, cube.obj, 'FollowPath')!.ops);
    expect(isAnimatable(s, cube.obj, 'position', 'vec3')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringMatching(/Follow-Path/),
    });
    expect(isAnimatable(s, cube.obj, 'scale', 'vec3').answer).toBe('animatable');
  });

  it('a driver supplies the radius, so a keyframe on it is not answered for', () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const math = place(sphere.s, 'Math');
    const bind = buildBindDriverOps(math.s, {
      targetId: sphere.data,
      paramPath: 'radius',
      source: { kind: 'output', id: 'm', label: 'm', ref: { node: math.obj, socket: 'out' } },
      driverId: 'drv',
    });
    expect(bind.ok).toBe(true);
    const s = apply(math.s, bind.ok ? bind.ops : []);
    expect(isAnimatable(s, sphere.data, 'radius', 'number')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringMatching(/driver/),
    });
  });
});

describe('animatablePathsOf — a picker list', () => {
  it("offers the spot light's live number params and none of the ones it ignores", () => {
    const spot = place(buildDefaultDagState(), 'SpotLight');
    const paths = animatablePathsOf(spot.s, spot.data, 'number')!;
    expect(paths).toEqual(expect.arrayContaining(['angle', 'penumbra', 'intensity']));
    expect(paths).not.toContain('width');
    expect(paths).not.toContain('height');
  });

  it('says it cannot answer for a subject the census never placed, rather than offering nothing', () => {
    let s = buildDefaultDagState();
    s = applyOp(s, { type: 'addNode', nodeId: 'shot', nodeType: 'Shot', params: {} }).next;
    expect(animatablePathsOf(s, 'shot', 'number')).toBeNull();
  });
});

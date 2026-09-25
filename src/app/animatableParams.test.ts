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
    // A subject no Add path places.
    let s = cube.s;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'tt',
      nodeType: 'TrackTo',
      params: { target: cube.obj },
    }).next;
    expect(isAnimatable(s, 'tt', 'aimPoint', 'vec3')).toEqual({
      answer: 'unmeasured',
      reason: 'the census places no TrackTo',
    });
    // A path the census never saw on a subject it did place.
    expect(isAnimatable(cube.s, cube.data, 'nonsense', 'number')).toMatchObject({
      answer: 'unmeasured',
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
    s = applyOp(s, { type: 'addNode', nodeId: 'tt', nodeType: 'TrackTo', params: {} }).next;
    expect(animatablePathsOf(s, 'tt', 'vec3')).toBeNull();
  });
});

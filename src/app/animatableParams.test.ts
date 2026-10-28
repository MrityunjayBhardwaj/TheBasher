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
import { buildSpringOps } from './solverBind';
import { buildNewMaterialOps } from './materialLink';
import {
  animatablePathPattern,
  animatablePathsOf,
  animatableSubjectOf,
  brokenReferences,
  isAnimatable,
  missingParamPath,
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

  it('keys a posable node by its rotation mode, and leaves the euler key bare (#1259)', () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const group = place(sphere.s, 'Group');
    const quat = [sphere.obj, group.obj].reduce(
      (s, id) =>
        applyOp(s, { type: 'setParam', nodeId: id, paramPath: 'rotationMode', value: 'quaternion' })
          .next,
      group.s,
    );
    expect([sphere.obj, group.obj, sphere.data].map((id) => animatableSubjectOf(quat, id))).toEqual(
      ['Object<SphereData>@quaternion', 'Group@quaternion', 'SphereData'],
    );
    // Back to euler (the product unsets the mode) is the bare key again.
    const euler = applyOp(quat, {
      type: 'setParam',
      nodeId: sphere.obj,
      paramPath: 'rotationMode',
      value: undefined,
    }).next;
    expect(animatableSubjectOf(euler, sphere.obj)).toBe('Object<SphereData>');
  });
});

describe('the rotation mode decides which rotation is drawn (#1259, measured)', () => {
  it("euler draws `rotation` and not `quaternion`; quaternion mode the reverse — Blender's rule", () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const seeded = applyOp(sphere.s, {
      type: 'setParam',
      nodeId: sphere.obj,
      paramPath: 'quaternion',
      value: [0, 0, 0, 1],
    }).next;
    const quat = applyOp(seeded, {
      type: 'setParam',
      nodeId: sphere.obj,
      paramPath: 'rotationMode',
      value: 'quaternion',
    }).next;
    const ask = (s: DagState, path: string, kind: 'vec3' | 'quat') =>
      isAnimatable(s, sphere.obj, path, kind).answer;
    expect({
      euler: {
        rotation: ask(seeded, 'rotation', 'vec3'),
        quaternion: ask(seeded, 'quaternion', 'quat'),
      },
      quaternion: {
        rotation: ask(quat, 'rotation', 'vec3'),
        quaternion: ask(quat, 'quaternion', 'quat'),
      },
    }).toEqual({
      euler: { rotation: 'animatable', quaternion: 'still' },
      quaternion: { rotation: 'still', quaternion: 'animatable' },
    });
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
    // A subject the census never places: a Strip is a placement on the timeline, not a scene object.
    const s = applyOp(cube.s, {
      type: 'addNode',
      nodeId: 'strip',
      nodeType: 'Strip',
      params: {},
    }).next;
    expect(isAnimatable(s, 'strip', 'start', 'number')).toEqual({
      answer: 'unmeasured',
      reason: 'the census places no Strip',
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

describe("a driver is answered from its own measurement, never the channel's (#1258)", () => {
  const apply = (st: DagState, ops: readonly Parameters<typeof applyOp>[1][]) => {
    let n = st;
    for (const op of ops) n = applyOp(n, op).next;
    return n;
  };
  /** A Sphere with a driver `driverId` on its radius, fed by a Math node's output. */
  function drivenSphere(driverIds: readonly string[]) {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    const math = place(sphere.s, 'Math');
    let s = math.s;
    for (const driverId of driverIds) {
      const bind = buildBindDriverOps(s, {
        targetId: sphere.data,
        paramPath: 'radius',
        source: { kind: 'output', id: 'm', label: 'm', ref: { node: math.obj, socket: 'out' } },
        driverId,
      });
      expect(bind.ok).toBe(true);
      s = apply(s, bind.ok ? bind.ops : []);
    }
    return { s, data: sphere.data };
  }

  it("a camera's fov animates under a channel and under a driver — the pose folds both (#480, #1266)", () => {
    const cam = place(buildDefaultDagState(), 'PerspectiveCamera');
    expect(isAnimatable(cam.s, cam.data, 'fov', 'number').answer).toBe('animatable');
    expect(isAnimatable(cam.s, cam.data, 'fov', 'number', { mechanism: 'driver' })).toMatchObject({
      answer: 'animatable',
      reach: 'scene',
    });
    expect(animatablePathsOf(cam.s, cam.data, 'number', { mechanism: 'driver' })).toContain('fov');
  });

  it("a sphere's radius animates under both", () => {
    const sphere = place(buildDefaultDagState(), 'Sphere');
    expect(
      isAnimatable(sphere.s, sphere.data, 'radius', 'number', { mechanism: 'driver' }),
    ).toMatchObject({ answer: 'animatable', reach: 'scene' });
  });

  it('a driver carries no colour, and says so rather than "still"', () => {
    const cube = place(buildDefaultDagState(), 'Cube');
    expect(
      isAnimatable(cube.s, cube.data, 'material.base.color', 'color', { mechanism: 'driver' }),
    ).toEqual({ answer: 'unmeasured', reason: 'a driver carries a number or a vec3, not a color' });
  });

  it("a driver asking about its own band is not 'something else supplies it'; another driver is", () => {
    const one = drivenSphere(['drv']);
    // Anyone else asking — a keyframe, or no one in particular — sees the driver as the supplier.
    expect(isAnimatable(one.s, one.data, 'radius', 'number')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringMatching(/driver/),
    });
    expect(
      isAnimatable(one.s, one.data, 'radius', 'number', { mechanism: 'driver', asker: 'drv' }),
    ).toMatchObject({ answer: 'animatable' });
    expect(
      animatablePathsOf(one.s, one.data, 'number', { mechanism: 'driver', asker: 'drv' }),
    ).toContain('radius');

    const two = drivenSphere(['drv', 'drv2']);
    expect(
      isAnimatable(two.s, two.data, 'radius', 'number', { mechanism: 'driver', asker: 'drv' }),
    ).toEqual({
      answer: 'unmeasured',
      reason: 'a driver supplies it, so a driver on it would not show',
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
    s = applyOp(s, { type: 'addNode', nodeId: 'strip', nodeType: 'Strip', params: {} }).next;
    expect(animatablePathsOf(s, 'strip', 'number')).toBeNull();
  });
});

// ── #1552 — a path that names no parameter ───────────────────────────────────────────

describe('missingParamPath — certain, or silent (#1552)', () => {
  const base = () => buildDefaultDagState();

  it('names a path neither the census nor the schema has, and offers what does animate', () => {
    for (const path of ['positoin', 'nosuchleaf', 'no.such.path']) {
      const missing = missingParamPath(base(), 'n_box', path, 'vec3');
      expect(missing, path).not.toBeNull();
      expect(missing!.nodeId, path).toBe('n_box');
      expect(missing!.animatable, path).toEqual(['position', 'rotation', 'scale']);
    }
  });

  it('CONTROL: a parameter the node has is never missing', () => {
    expect(missingParamPath(base(), 'n_box', 'position', 'vec3')).toBeNull();
    // Measured as not moving anything: that is `still`, a different answer from missing.
    expect(isAnimatable(base(), 'n_box', 'quaternion', 'quat').answer).toBe('still');
    expect(missingParamPath(base(), 'n_box', 'quaternion', 'quat')).toBeNull();
  });

  it('follows a data parameter named on the Object to the node that owns it', () => {
    expect(missingParamPath(base(), 'n_box', 'material.base.color', 'color')).toBeNull();
    const missing = missingParamPath(base(), 'n_box_data', 'material.base.colr', 'color');
    expect(missing?.nodeId).toBe('n_box_data');
    expect(missing?.animatable).toContain('material.base.color');
  });

  it('says nothing when the schema keeps the path, though the census has no row for it', () => {
    // `parentBone` is a parameter of an Object that no placed cube holds, so the census never
    // keyed it. It is not missing: the schema keeps a value written there.
    expect(isAnimatable(base(), 'n_box', 'parentBone', 'color')).toMatchObject({
      answer: 'unmeasured',
      reason: expect.stringContaining('the census found no parentBone'),
    });
    expect(missingParamPath(base(), 'n_box', 'parentBone', 'color')).toBeNull();
    // And a sample the schema refuses outright says nothing about the path either.
    expect(missingParamPath(base(), 'n_box', 'position.0', 'vec3')).toBeNull();
  });

  it('says nothing about a node the census never placed, whatever its schema says', () => {
    const s = applyOp(base(), {
      type: 'addNode',
      nodeId: 'wf',
      nodeType: 'ComfyUIWorkflow',
      params: {},
    }).next;
    expect(animatableSubjectOf(s, 'wf')).toBe('ComfyUIWorkflow');
    // A ComfyUI input is in no schema, and animates.
    expect(missingParamPath(s, 'wf', 'comfy:6.text', 'number')).toBeNull();
    expect(missingParamPath(s, 'wf', 'controller:10', 'number')).toBeNull();
  });

  it('says nothing under an operator stack, which the census does not measure', () => {
    let s = base();
    // The control first: the same question on the bare mesh has an answer.
    expect(missingParamPath(s, 'n_box_data', 'nosuchleaf', 'number')).not.toBeNull();
    for (const op of buildAddModifierOps(s, 'n_box_data', 'UVProjectModifier')!.ops)
      s = applyOp(s, op).next;
    expect(missingParamPath(s, 'n_box_data', 'nosuchleaf', 'number')).toBeNull();
  });

  it('says nothing about a node that is not there', () => {
    expect(missingParamPath(base(), 'ghost', 'position', 'vec3')).toBeNull();
  });
});

describe('brokenReferences — a raw operation is stored, and reported (#1552)', () => {
  const channel = (nodeId: string, target: string, paramPath: string) =>
    ({
      type: 'addNode',
      nodeId,
      nodeType: 'KeyframeChannelVec3',
      params: { name: paramPath, target, paramPath, keyframes: [] },
    }) as const;
  const build = (...ops: Parameters<typeof applyOp>[1][]) =>
    ops.reduce((state, op) => applyOp(state, op).next, buildDefaultDagState());

  it('a channel on a missing path is accepted by the raw door and listed', () => {
    const s = build(channel('ch_typo', 'n_box', 'positoin'));
    expect(s.nodes.ch_typo).toBeDefined();
    expect(brokenReferences(s)).toEqual([
      {
        node: 'ch_typo',
        type: 'KeyframeChannelVec3',
        target: 'n_box',
        paramPath: 'positoin',
        problem: 'Object has no such parameter',
      },
    ]);
  });

  it('a channel on a node that is not there is listed too', () => {
    const s = build(channel('ch_ghost', 'ghost', 'position'));
    expect(brokenReferences(s)).toEqual([
      {
        node: 'ch_ghost',
        type: 'KeyframeChannelVec3',
        target: 'ghost',
        problem: 'names a node that is not in the graph',
      },
    ]);
  });

  it('a driver on a missing path is listed', () => {
    const s = build({
      type: 'addNode',
      nodeId: 'drv',
      nodeType: 'ParamDriver',
      params: { target: 'n_light_data', paramPath: 'intensty' },
    });
    expect(brokenReferences(s).map((b) => [b.node, b.paramPath])).toEqual([['drv', 'intensty']]);
  });

  it('CONTROL: working channels and drivers are not listed', () => {
    const s = build(channel('ch_ok', 'n_box', 'position'), {
      type: 'addNode',
      nodeId: 'drv_ok',
      nodeType: 'ParamDriver',
      params: { target: 'n_light_data', paramPath: 'intensity' },
    });
    expect(brokenReferences(s)).toEqual([]);
    expect(brokenReferences(buildDefaultDagState())).toEqual([]);
  });

  it('a reference that resolves again leaves the list, with nothing stored to clear', () => {
    const broken = build(channel('ch_typo', 'n_box', 'positoin'));
    const fixed = applyOp(broken, {
      type: 'setParam',
      nodeId: 'ch_typo',
      paramPath: 'paramPath',
      value: 'position',
    }).next;
    expect(brokenReferences(broken)).toHaveLength(1);
    expect(brokenReferences(fixed)).toEqual([]);
  });
});

describe('the driver authoring doors refuse a path that names no parameter (#1552)', () => {
  const null_ = (state: DagState) => place(state, 'Cube');
  const source = (node: string) =>
    ({ kind: 'transform', id: 's', label: 's', node, channel: 'tx' }) as const;

  it('bind refuses a mistyped path, and takes the real one', () => {
    const { s, obj } = null_(buildDefaultDagState());
    const req = { targetId: 'n_light_data', source: source(obj), driverId: 'drv' };
    expect(buildBindDriverOps(s, { ...req, paramPath: 'intensty' })).toEqual({
      ok: false,
      reason: "'intensty' is not a parameter: LightData has no such parameter",
    });
    expect(buildBindDriverOps(s, { ...req, paramPath: 'intensity' }).ok).toBe(true);
  });

  it('spring refuses a mistyped path, and takes the real one', () => {
    const { s, obj } = null_(buildDefaultDagState());
    const req = { targetId: 'n_box', controllerId: obj, idFor: (n: string) => `sp_${n}` };
    expect(buildSpringOps(s, { ...req, paramPath: 'positoin' })).toEqual({
      ok: false,
      reason: "'positoin' is not a parameter: Object has no such parameter",
    });
    expect(buildSpringOps(s, { ...req, paramPath: 'position' }).ok).toBe(true);
  });
});

// #1784 — the Transform nodes and their math.
//
// Three kinds of check:
//   1. The math against three.js, on seeded random transforms, wherever the two agree.
//   2. The places Blender and three.js DISAGREE, pinned to Blender's answer (the nodes are
//      Blender's matrix nodes): a mirrored transform, a projective bottom row, an unnormalised
//      direction, a singular transform, shear, a zero scale.
//   3. The nodes in a real graph: wired through `connect` (which checks socket types) and
//      `evaluate`; and a transform built in the graph equals the world matrix Basher places
//      an object with, so a rotation here means what an object's `rotation` means.

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { getNodeType } from '../core/dag/registry';
import { emptyDagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { resolveWorldTransform } from '../app/resolveWorldTransform';
import { COMPUTE_KINDS } from '../app/addPrimitives';
import { registerAllNodes } from './registerAll';
import { mulberry32 } from './random';
import type { Quat, Vec3 } from './types';
import {
  composeTransform,
  eulerToQuat,
  IDENTITY_MAT4,
  invertTransform,
  type Mat4,
  multiplyTransforms,
  quatToEuler,
  separateTransform,
  transformDirection,
  transformPoint,
} from '../core/math/transformMath';
import { InvertTransformNode, TRANSFORM_NODES } from './transformNodes';

beforeAll(() => registerAllNodes());

const rand = mulberry32(1784);
const r = (lo: number, hi: number) => lo + (hi - lo) * rand();
const rv = (lo: number, hi: number): Vec3 => [r(lo, hi), r(lo, hi), r(lo, hi)];
const rq = (): Quat => {
  const q = new THREE.Quaternion(r(-1, 1), r(-1, 1), r(-1, 1), r(-1, 1)).normalize();
  return [q.x, q.y, q.z, q.w];
};
const rs = (): Vec3 => [r(0.2, 3), r(0.2, 3), r(0.2, 3)];
const toThree = (m: Mat4) => new THREE.Matrix4().fromArray([...m]);
const expectClose = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};
/** Same orientation: q and −q are one rotation. */
const expectSameRotation = (a: Quat, b: Quat) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  expect(Math.abs(dot)).toBeCloseTo(1, 9);
};
const CASES = 50;

describe('#1784 transform math agrees with three.js where three and Blender agree', () => {
  it('compose, multiply and invert', () => {
    for (let i = 0; i < CASES; i++) {
      const [t, q, s] = [rv(-10, 10), rq(), rs()];
      const m = composeTransform(t, q, s);
      const ref = new THREE.Matrix4().compose(
        new THREE.Vector3(...t),
        new THREE.Quaternion(...q),
        new THREE.Vector3(...s),
      );
      expectClose(m, ref.elements);
      const n = composeTransform(rv(-10, 10), rq(), rs());
      expectClose(multiplyTransforms(m, n), ref.clone().multiply(toThree(n)).elements);
      expectClose(invertTransform(m)!, ref.clone().invert().elements);
    }
  });

  it('Euler (degrees, XYZ) ↔ quaternion, as three converts them', () => {
    for (let i = 0; i < CASES; i++) {
      const e = rv(-170, 170);
      const D = Math.PI / 180;
      const ref = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(e[0] * D, e[1] * D, e[2] * D, 'XYZ'),
      );
      expectClose(eulerToQuat(e), [ref.x, ref.y, ref.z, ref.w]);
      const q = rq();
      const back = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...q), 'XYZ');
      expectClose(quatToEuler(q), [back.x / D, back.y / D, back.z / D], 7);
    }
  });

  it('a point on an affine transform, and a direction through its 3×3', () => {
    for (let i = 0; i < CASES; i++) {
      const m = composeTransform(rv(-10, 10), rq(), rs());
      const p = rv(-5, 5);
      const v = new THREE.Vector3(...p).applyMatrix4(toThree(m));
      expectClose(transformPoint(m, p), [v.x, v.y, v.z]);
      const d = new THREE.Vector3(...p).applyMatrix3(
        new THREE.Matrix3().setFromMatrix4(toThree(m)),
      );
      expectClose(transformDirection(m, p), [d.x, d.y, d.z]);
    }
  });

  it('separate gives back what combine took, for a transform that is not mirrored', () => {
    for (let i = 0; i < CASES; i++) {
      const [t, q, s] = [rv(-10, 10), rq(), rs()];
      const out = separateTransform(composeTransform(t, q, s));
      expectClose(out.translation, t);
      expectClose(out.scale, s);
      expectSameRotation(out.rotation, q);
    }
  });
});

describe('#1784 where Blender and three.js disagree, the nodes answer as Blender does', () => {
  it('a mirrored transform separates with ALL three scales negative, and recombines exactly', () => {
    const q = eulerToQuat([20, -35, 60]);
    const m = composeTransform([1, 2, 3], q, [-1, 2, 3]);
    const out = separateTransform(m);
    // Blender `to_rot_scale<true>`: a negative determinant negates every column length.
    expect(out.scale.every((v) => v < 0)).toBe(true);
    expectClose(
      out.scale.map((v) => Math.abs(v)),
      [1, 2, 3],
    );
    expectClose(composeTransform(out.translation, out.rotation, out.scale), m);
    // three's decompose negates X only — the disagreement this pins.
    const ts = new THREE.Vector3();
    toThree(m).decompose(new THREE.Vector3(), new THREE.Quaternion(), ts);
    expect([ts.x < 0, ts.y < 0, ts.z < 0]).toEqual([true, false, false]);
  });

  it('Transform Point ignores a projective bottom row (no divide by w)', () => {
    const m = [...IDENTITY_MAT4];
    m[3] = 1; // row 3, column 0: w = x + 1
    m[12] = 5;
    // Every axis non-zero, so a divide by w (here 3) on any one of them shows.
    expectClose(transformPoint(m, [2, -1, 4]), [7, -1, 4]);
    const three = new THREE.Vector3(2, -1, 4).applyMatrix4(toThree(m));
    expectClose([three.x, three.y, three.z], [7 / 3, -1 / 3, 4 / 3]); // three divides by w = 3
  });

  it('Transform Direction scales and turns but neither moves nor normalises', () => {
    const m = composeTransform([9, 9, 9], eulerToQuat([0, 0, 90]), [2, 2, 2]);
    expectClose(transformDirection(m, [1, 0, 0]), [0, 2, 0]);
  });

  it('an uninvertible transform: the math says so, the node outputs the identity', () => {
    const flat = composeTransform([1, 2, 3], eulerToQuat([10, 20, 30]), [1, 0, 1]);
    expect(invertTransform(flat)).toBeNull();
    expect(InvertTransformNode.evaluate({}, { transform: flat }, {} as never)).toEqual(
      IDENTITY_MAT4,
    );
    // Tiny but non-zero is still invertible (Blender's threshold is exactly 0).
    const tiny = composeTransform([0, 0, 0], [0, 0, 0, 1], [1e-6, 1, 1]);
    expect(invertTransform(tiny)![0]).toBeCloseTo(1e6, 3);
  });

  it('a sheared transform still separates into a unit rotation; a zero scale gives no NaN', () => {
    const shear = [...IDENTITY_MAT4];
    shear[4] = 0.7; // column 1 leans into x
    const s = separateTransform(shear);
    expect(Math.hypot(...s.rotation)).toBeCloseTo(1, 9);
    const flat = separateTransform(composeTransform([1, 1, 1], eulerToQuat([0, 30, 0]), [0, 1, 1]));
    expect([...flat.translation, ...flat.rotation, ...flat.scale].every(Number.isFinite)).toBe(
      true,
    );
    expect(flat.scale[0]).toBe(0);
  });
});

describe('#1784 the nodes in a graph', () => {
  const vecSource = (id: string): Op => ({
    type: 'addNode',
    nodeId: id,
    nodeType: 'MakeVec3',
    params: {},
  });
  const add = (id: string, nodeType: string): Op => ({
    type: 'addNode',
    nodeId: id,
    nodeType,
    params: {},
  });
  const wire = (from: string, fs: string, to: string, ts: string): Op => ({
    type: 'connect',
    from: { node: from, socket: fs },
    to: { node: to, socket: ts },
  });
  const build = (ops: Op[]): DagState =>
    ops.reduce((s, op) => applyOp(s, op).next, emptyDagState()); // applyOp throws on refusal

  const T: Vec3 = [1, -2, 3];
  const E: Vec3 = [30, 40, 50];
  const S: Vec3 = [2, 0.5, 1.5];
  const overrides = new Map<string, unknown>([
    ['t', T],
    ['e', E],
    ['s', S],
    ['p', [1, 1, 1]],
  ]);
  const graph = (): DagState =>
    build([
      vecSource('t'),
      vecSource('e'),
      vecSource('s'),
      vecSource('p'),
      add('rot', 'EulerToRotation'),
      add('comb', 'CombineTransform'),
      add('sep', 'SeparateTransform'),
      add('inv', 'InvertTransform'),
      add('mul', 'MultiplyTransforms'),
      add('pt', 'TransformPoint'),
      add('back', 'RotationToEuler'),
      wire('e', 'out', 'rot', 'euler'),
      wire('t', 'out', 'comb', 'translation'),
      wire('rot', 'out', 'comb', 'rotation'),
      wire('s', 'out', 'comb', 'scale'),
      wire('comb', 'out', 'sep', 'transform'),
      wire('comb', 'out', 'inv', 'transform'),
      wire('comb', 'out', 'mul', 'a'),
      wire('inv', 'out', 'mul', 'b'),
      wire('p', 'out', 'pt', 'point'),
      wire('comb', 'out', 'pt', 'transform'),
      wire('sep', 'rotation', 'back', 'rotation'),
    ]);

  it('every node is registered, in the Add menu, and wires up by its declared types', () => {
    for (const def of TRANSFORM_NODES) {
      expect(getNodeType(def.type), def.type).toBeDefined();
      expect(COMPUTE_KINDS as readonly string[]).toContain(def.type);
    }
    expect(() => graph()).not.toThrow();
  });

  it('combine → separate round-trips; T · T⁻¹ is the identity; a point lands where three puts it', () => {
    const s = graph();
    const comb = evaluate(s, 'comb', { overrides }).value as Mat4;
    const sep = evaluate(s, 'sep', { overrides }).value as {
      translation: Vec3;
      rotation: Quat;
      scale: Vec3;
    };
    expectClose(sep.translation, T);
    expectClose(sep.scale, S);
    expectClose(evaluate(s, 'back', { overrides }).value as Vec3, E, 7);
    expectClose(evaluate(s, 'mul', { overrides }).value as Mat4, IDENTITY_MAT4);
    const want = new THREE.Vector3(1, 1, 1).applyMatrix4(toThree(comb));
    expectClose(evaluate(s, 'pt', { overrides }).value as Vec3, [want.x, want.y, want.z]);
  });

  it('a transform cannot be wired where a vector is expected', () => {
    const s = build([add('comb', 'CombineTransform'), add('pt', 'TransformPoint')]);
    expect(() => applyOp(s, wire('comb', 'out', 'pt', 'point'))).toThrow(/Matrix4/);
    // …and the same socket takes a vector (the refusal is about the type, not the socket).
    const v = build([add('v', 'MakeVec3'), add('pt', 'TransformPoint')]);
    expect(() => applyOp(v, wire('v', 'out', 'pt', 'point'))).not.toThrow();
  });

  it("Blender's implicit conversions: a vector or a transform into a rotation, a rotation into a vector or a transform", () => {
    const s = build([
      vecSource('e'),
      add('comb', 'CombineTransform'),
      add('viaNode', 'EulerToRotation'),
      add('combViaNode', 'CombineTransform'),
      add('back', 'RotationToEuler'),
      add('asVec', 'Vec3Math'),
      add('asMat', 'MultiplyTransforms'),
      wire('e', 'out', 'comb', 'rotation'), // Vector3 → Quaternion: read as an Euler
      wire('e', 'out', 'viaNode', 'euler'),
      wire('viaNode', 'out', 'combViaNode', 'rotation'),
      wire('comb', 'out', 'back', 'rotation'), // Matrix4 → Quaternion: its rotation part
      wire('viaNode', 'out', 'asVec', 'a'), // Quaternion → Vector3: written as an Euler
      wire('viaNode', 'out', 'asMat', 'a'), // Quaternion → Matrix4: a pure rotation
    ]);
    const o = new Map<string, unknown>([['e', E]]);
    const value = (id: string) => evaluate(s, id, { overrides: o }).value as number[];
    expectClose(value('comb'), value('combViaNode'));
    expectClose(value('back'), E, 7);
    expectClose(value('asVec'), E, 7); // Vec3Math add with b unconnected (0)
    expectClose(value('asMat'), composeTransform([0, 0, 0], eulerToQuat(E), [1, 1, 1]));
  });

  it('a pair Blender does not convert is refused, naming both types', () => {
    const s = build([
      add('comb', 'CombineTransform'),
      add('rot', 'EulerToRotation'),
      add('m', 'Math'),
    ]);
    expect(() => applyOp(s, wire('comb', 'out', 'm', 'a'))).toThrow(
      /no conversion from Matrix4 to Number/,
    );
    expect(() => applyOp(s, wire('rot', 'out', 'm', 'a'))).toThrow(
      /no conversion from Quaternion to Number/,
    );
  });

  it("combining an object's own position, rotation and scale gives the world matrix Basher places it with", () => {
    const pos: Vec3 = [1.5, 2, -3];
    const rot: Vec3 = [30, 40, 50];
    const scl: Vec3 = [1, 2, 0.5];
    let s = buildDefaultDagState();
    for (const [paramPath, value] of [
      ['position', pos],
      ['rotation', rot],
      ['scale', scl],
    ] as const)
      s = applyOp(s, { type: 'setParam', nodeId: 'n_box', paramPath, value: [...value] }).next;
    const world = resolveWorldTransform(s, 'n_box', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    })!;
    expectClose(composeTransform(pos, eulerToQuat(rot), scl), world.matrix);
  });
});

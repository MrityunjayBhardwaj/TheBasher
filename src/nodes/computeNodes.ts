// computeNodes — the stateless compute-node vocabulary for procedural relations
// (#292, Epic 1 Inc 1, decision D-1).
//
// A cohesive family of tiny, PURE scalar operators that compose into relation
// graphs (a driver, Inc 2, wires one of these onto a target param via the pull
// rail). Packaging per D-1: ONE `Math` node with an op-enum for trivial arithmetic
// (add/sub/mul/div) + purpose-named nodes for the richer ops (Fit, Clamp,
// CurveRemap, Mix, Noise). All value math comes from the ONE shared core
// (valueMath.ts) so these cannot drift from the animation F-Modifier stack.
//
// Scope: SCALAR ('Number' socket) for Inc 1 — the common driver target shape.
// Unconnected numeric inputs default to 0 (so a node is evaluable before its
// sources are wired). Leaf sources (a promoted spare param, another node's param)
// arrive with the driver-binding UI in Inc 2.
//
// REF: Houdini VOP add/mul/fit/clamp/ramp; Blender geometry-node Math/Map Range;
//      #292; memory project_drivers-controllers-opnet (D-1).

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { Quat, Vec3 } from './types';
import { IDENTITY_MAT4, isMat4, type Mat4 } from '../core/math/transformMath';
import { IDENTITY_QUAT, slerp } from './quatMath';
import {
  applyMathOp,
  applyVec3Op,
  clamp,
  curveRemap,
  fit,
  fractalNoise,
  lerp,
  MATH_OPS,
  type MathOp,
  VEC3_OPS,
  type Vec3Op,
} from './valueMath';

const NUMBER_OUT = { out: { type: 'Number', cardinality: 'single' } } as const;
const VECTOR3_OUT = { out: { type: 'Vector3', cardinality: 'single' } } as const;
const num = (inputs: Record<string, unknown>, key: string): number =>
  (inputs[key] as number | undefined) ?? 0;
/** An unconnected Quaternion input defaults to no rotation. */
const quat = (inputs: Record<string, unknown>, key: string): Quat => {
  const v = inputs[key];
  return Array.isArray(v) && v.length === 4 ? (v as unknown as Quat) : IDENTITY_QUAT;
};
/** An unconnected Matrix4 input defaults to the identity. */
const matrix = (inputs: Record<string, unknown>, key: string): Mat4 => {
  const v = inputs[key];
  return isMat4(v) ? v : IDENTITY_MAT4;
};
/** An unconnected Vector3 input defaults to the origin (mirrors `num`'s 0 default). */
const vec3 = (inputs: Record<string, unknown>, key: string): Vec3 =>
  (inputs[key] as Vec3 | undefined) ?? [0, 0, 0];

// ── Math — binary arithmetic via an op-enum ──────────────────────────────────
export const MathParams = z.object({
  op: z.enum(MATH_OPS as unknown as [MathOp, ...MathOp[]]).default('add'),
});
export type MathParams = z.infer<typeof MathParams>;

export const MathNode: NodeDefinition<MathParams, number> = {
  type: 'Math',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MathParams,
  inputs: {
    a: { type: 'Number', cardinality: 'single', owns: 'always' },
    b: { type: 'Number', cardinality: 'single', owns: 'always' },
  },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) => applyMathOp(params.op, num(inputs, 'a'), num(inputs, 'b')),
};

// ── Clamp — bound a value into [min, max] ────────────────────────────────────
export const ClampParams = z.object({
  min: z.number().default(0),
  max: z.number().default(1),
});
export type ClampParams = z.infer<typeof ClampParams>;

export const ClampNode: NodeDefinition<ClampParams, number> = {
  type: 'Clamp',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: ClampParams,
  inputs: { in: { type: 'Number', cardinality: 'single', owns: 'always' } },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) => clamp(num(inputs, 'in'), params.min, params.max),
};

// ── Fit — map an input range onto an output range (Houdini fit) ───────────────
// #1802 — Fit is Basher's Map Range, and like Blender's it has a Vector mode
// (node_shader_map_range.cc): `inVector` → `outVector`, each axis remapped through its own
// range, clamp applied per axis. Number mode keeps the old sockets and params, and a Fit saved
// before the mode existed reads as Number (#1801).
const VEC3_PARAM = (d: number) => z.tuple([z.number(), z.number(), z.number()]).default([d, d, d]);
export const FIT_DATA_TYPES = ['Number', 'Vector'] as const;
export const FitParams = z.object({
  inMin: z.number().default(0),
  inMax: z.number().default(1),
  outMin: z.number().default(0),
  outMax: z.number().default(1),
  clamp: z.boolean().default(false),
  dataType: z.enum(FIT_DATA_TYPES).default('Number'),
  inMinVector: VEC3_PARAM(0),
  inMaxVector: VEC3_PARAM(1),
  outMinVector: VEC3_PARAM(0),
  outMaxVector: VEC3_PARAM(1),
});
export type FitParams = z.infer<typeof FitParams>;

const fitWhen = (dataType: (typeof FIT_DATA_TYPES)[number]) =>
  ({ param: 'dataType', in: [dataType] }) as const;

export const FitNode: NodeDefinition<FitParams, number | Vec3> = {
  type: 'Fit',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: FitParams,
  inputs: {
    in: { type: 'Number', cardinality: 'single', owns: 'always', available: fitWhen('Number') },
    inVector: {
      type: 'Vector3',
      cardinality: 'single',
      owns: 'always',
      available: fitWhen('Vector'),
    },
  },
  outputs: {
    out: { type: 'Number', cardinality: 'single', available: fitWhen('Number') },
    outVector: { type: 'Vector3', cardinality: 'single', available: fitWhen('Vector') },
  },
  evaluate: (params, inputs) => {
    if (params.dataType === 'Vector') {
      const v = vec3(inputs, 'inVector');
      const axis = (i: 0 | 1 | 2) =>
        fit(
          v[i],
          params.inMinVector[i],
          params.inMaxVector[i],
          params.outMinVector[i],
          params.outMaxVector[i],
          params.clamp,
        );
      return [axis(0), axis(1), axis(2)];
    }
    return fit(
      num(inputs, 'in'),
      params.inMin,
      params.inMax,
      params.outMin,
      params.outMax,
      params.clamp,
    );
  },
};
// ── Mix — blend a and b by `factor`: numbers, vectors or rotations ─────────────
// #1801 — one Mix for every value type, as Blender's is: a socket per type (`a`/`b`/`out` for a
// Number, `aVector`/… for a Vector3, `aRotation`/… for a Quaternion), and `dataType` decides
// which are available (node_shader_mix.cc). A Number or a Vector lerps; a Rotation blends along
// the shortest arc (Blender's `math::interpolate`), because lerping the numbers of two
// orientations takes the wrong path. The Number sockets keep their names, so a Mix saved before
// the mode existed loads as a Number Mix with its wires in place.
// `factor` is a socket as well as a setting (#1811), as Blender's is: a wire wins, and with none the
// setting is the value, so a Mix saved before the socket existed reads the same. A Matrix lerps
// entry by entry, which is what the stretch part of a blended transform needs; it is not a way to
// blend whole transforms, whose rotation would take the wrong path (`transformBlend.test.ts`).
export const MIX_DATA_TYPES = ['Number', 'Vector', 'Rotation', 'Matrix'] as const;
export const MixParams = z.object({
  factor: z.number().default(0.5),
  dataType: z.enum(MIX_DATA_TYPES).default('Number'),
});
export type MixParams = z.infer<typeof MixParams>;

const when = (dataType: (typeof MIX_DATA_TYPES)[number]) =>
  ({ param: 'dataType', in: [dataType] }) as const;

export const MixNode: NodeDefinition<MixParams, number | Vec3 | Quat | Mat4> = {
  type: 'Mix',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MixParams,
  inputs: {
    factor: { type: 'Number', cardinality: 'single', owns: 'always' },
    a: { type: 'Number', cardinality: 'single', owns: 'always', available: when('Number') },
    b: { type: 'Number', cardinality: 'single', owns: 'always', available: when('Number') },
    aVector: { type: 'Vector3', cardinality: 'single', owns: 'always', available: when('Vector') },
    bVector: { type: 'Vector3', cardinality: 'single', owns: 'always', available: when('Vector') },
    aRotation: {
      type: 'Quaternion',
      cardinality: 'single',
      owns: 'always',
      available: when('Rotation'),
    },
    bRotation: {
      type: 'Quaternion',
      cardinality: 'single',
      owns: 'always',
      available: when('Rotation'),
    },
    aMatrix: { type: 'Matrix4', cardinality: 'single', owns: 'always', available: when('Matrix') },
    bMatrix: { type: 'Matrix4', cardinality: 'single', owns: 'always', available: when('Matrix') },
  },
  outputs: {
    out: { type: 'Number', cardinality: 'single', available: when('Number') },
    outVector: { type: 'Vector3', cardinality: 'single', available: when('Vector') },
    outRotation: { type: 'Quaternion', cardinality: 'single', available: when('Rotation') },
    outMatrix: { type: 'Matrix4', cardinality: 'single', available: when('Matrix') },
  },
  // One value: the current mode's. Only that mode's output is available, so it is the only one
  // a live wire reads.
  evaluate: (params, inputs) => {
    const t = typeof inputs.factor === 'number' ? inputs.factor : params.factor;
    switch (params.dataType ?? 'Number') {
      case 'Vector':
        return applyVec3Op('mix', vec3(inputs, 'aVector'), vec3(inputs, 'bVector'), t);
      case 'Rotation':
        return slerp(quat(inputs, 'aRotation'), quat(inputs, 'bRotation'), t);
      case 'Matrix': {
        const a = matrix(inputs, 'aMatrix');
        const b = matrix(inputs, 'bMatrix');
        return t === 0 ? a : t === 1 ? b : a.map((v, i) => lerp(v, b[i], t));
      }
      default:
        return lerp(num(inputs, 'a'), num(inputs, 'b'), t);
    }
  },
};

// ── CurveRemap — piecewise-linear ramp remap ─────────────────────────────────
export const CurveRemapParams = z.object({
  points: z.array(z.object({ x: z.number(), y: z.number() })).default([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]),
});
export type CurveRemapParams = z.infer<typeof CurveRemapParams>;

export const CurveRemapNode: NodeDefinition<CurveRemapParams, number> = {
  type: 'CurveRemap',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CurveRemapParams,
  inputs: { in: { type: 'Number', cardinality: 'single', owns: 'always' } },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) => curveRemap(num(inputs, 'in'), params.points),
};

// ── Noise — deterministic fractal value-noise of the input ───────────────────
export const NoiseParams = z.object({
  scale: z.number().default(1),
  phase: z.number().default(0),
  octaves: z.number().int().default(3),
  amplitude: z.number().default(1),
  offset: z.number().default(0),
});
export type NoiseParams = z.infer<typeof NoiseParams>;

export const NoiseNode: NodeDefinition<NoiseParams, number> = {
  type: 'Noise',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NoiseParams,
  inputs: { t: { type: 'Number', cardinality: 'single', owns: 'always' } },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) =>
    fractalNoise(num(inputs, 't') * params.scale + params.phase, params.octaves) *
      params.amplitude +
    params.offset,
};

// ── vector nodes (Vector3 rail — vectors first-class on the compute rail) ─────
// The Vec3 twin of the scalar vocab above: build a vector from components, do
// vector arithmetic, break it back to components. A Vec3 flows through these and
// drives a Vector3 target (position) exactly as a Number flows through Math/Fit and
// drives a scalar — closing the scalar-only gap on the compute/driver rail. All
// vector math comes from the ONE shared core (valueMath.ts), like the scalar nodes.

// ── MakeVec3 — assemble a Vector3 from three scalar inputs ────────────────────
export const MakeVec3Node: NodeDefinition<Record<string, never>, Vec3> = {
  type: 'MakeVec3',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: z.object({}),
  inputs: {
    x: { type: 'Number', cardinality: 'single', owns: 'always' },
    y: { type: 'Number', cardinality: 'single', owns: 'always' },
    z: { type: 'Number', cardinality: 'single', owns: 'always' },
  },
  outputs: VECTOR3_OUT,
  evaluate: (_params, inputs) => [num(inputs, 'x'), num(inputs, 'y'), num(inputs, 'z')],
};

// ── VecBreak3 — split a Vector3 into its x / y / z scalar outputs ──────────────
// A multi-output node: `evaluate` returns a record and each consumer references the
// socket it wants (`extractSocket` picks it). Lets a scalar target/driver read one
// axis of a vector chain (or a spring's driven component).
export const VecBreak3Node: NodeDefinition<
  Record<string, never>,
  { x: number; y: number; z: number }
> = {
  type: 'VecBreak3',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: z.object({}),
  inputs: { v: { type: 'Vector3', cardinality: 'single', owns: 'always' } },
  outputs: {
    x: { type: 'Number', cardinality: 'single' },
    y: { type: 'Number', cardinality: 'single' },
    z: { type: 'Number', cardinality: 'single' },
  },
  evaluate: (_params, inputs) => {
    const v = vec3(inputs, 'v');
    return { x: v[0], y: v[1], z: v[2] };
  },
};

// ── Vec3Math — vector arithmetic via an op-enum (the Vec3 twin of Math) ────────
export const Vec3MathParams = z.object({
  op: z.enum(VEC3_OPS as unknown as [Vec3Op, ...Vec3Op[]]).default('add'),
  /** The scalar operand for `scale`/`mix` when the `s` input is unconnected. */
  scalar: z.number().default(1),
});
export type Vec3MathParams = z.infer<typeof Vec3MathParams>;

export const Vec3MathNode: NodeDefinition<Vec3MathParams, Vec3> = {
  type: 'Vec3Math',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: Vec3MathParams,
  inputs: {
    a: { type: 'Vector3', cardinality: 'single', owns: 'always' },
    b: { type: 'Vector3', cardinality: 'single', owns: 'always' },
    // Optional scalar override for scale/mix (spring wires velocity·dt here); falls
    // back to the `scalar` param when unconnected.
    s: { type: 'Number', cardinality: 'single', owns: 'always' },
  },
  outputs: VECTOR3_OUT,
  evaluate: (params, inputs) => {
    const s = typeof inputs.s === 'number' ? inputs.s : params.scalar;
    return applyVec3Op(params.op, vec3(inputs, 'a'), vec3(inputs, 'b'), s);
  },
};

/** The compute-node vocabulary, for bulk registration (registerAll.ts). */
export const COMPUTE_NODES: NodeDefinition[] = (
  [
    MathNode as unknown as NodeDefinition,
    ClampNode as unknown as NodeDefinition,
    FitNode as unknown as NodeDefinition,
    MixNode as unknown as NodeDefinition,
    CurveRemapNode as unknown as NodeDefinition,
    NoiseNode as unknown as NodeDefinition,
    MakeVec3Node as unknown as NodeDefinition,
    VecBreak3Node as unknown as NodeDefinition,
    Vec3MathNode as unknown as NodeDefinition,
  ] as NodeDefinition[]
).map((def) => ({ ...def, keyedCook: true })); // #575

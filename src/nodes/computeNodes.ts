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
import type { Vec3 } from './types';
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
    a: { type: 'Number', cardinality: 'single' },
    b: { type: 'Number', cardinality: 'single' },
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
  inputs: { in: { type: 'Number', cardinality: 'single' } },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) => clamp(num(inputs, 'in'), params.min, params.max),
};

// ── Fit — map an input range onto an output range (Houdini fit) ───────────────
export const FitParams = z.object({
  inMin: z.number().default(0),
  inMax: z.number().default(1),
  outMin: z.number().default(0),
  outMax: z.number().default(1),
  clamp: z.boolean().default(false),
});
export type FitParams = z.infer<typeof FitParams>;

export const FitNode: NodeDefinition<FitParams, number> = {
  type: 'Fit',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: FitParams,
  inputs: { in: { type: 'Number', cardinality: 'single' } },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) =>
    fit(num(inputs, 'in'), params.inMin, params.inMax, params.outMin, params.outMax, params.clamp),
};

// ── Mix — linear blend of a and b by `factor` ────────────────────────────────
export const MixParams = z.object({
  factor: z.number().default(0.5),
});
export type MixParams = z.infer<typeof MixParams>;

export const MixNode: NodeDefinition<MixParams, number> = {
  type: 'Mix',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: MixParams,
  inputs: {
    a: { type: 'Number', cardinality: 'single' },
    b: { type: 'Number', cardinality: 'single' },
  },
  outputs: NUMBER_OUT,
  evaluate: (params, inputs) => lerp(num(inputs, 'a'), num(inputs, 'b'), params.factor),
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
  inputs: { in: { type: 'Number', cardinality: 'single' } },
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
  inputs: { t: { type: 'Number', cardinality: 'single' } },
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
    x: { type: 'Number', cardinality: 'single' },
    y: { type: 'Number', cardinality: 'single' },
    z: { type: 'Number', cardinality: 'single' },
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
  inputs: { v: { type: 'Vector3', cardinality: 'single' } },
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
    a: { type: 'Vector3', cardinality: 'single' },
    b: { type: 'Vector3', cardinality: 'single' },
    // Optional scalar override for scale/mix (spring wires velocity·dt here); falls
    // back to the `scalar` param when unconnected.
    s: { type: 'Number', cardinality: 'single' },
  },
  outputs: VECTOR3_OUT,
  evaluate: (params, inputs) => {
    const s = typeof inputs.s === 'number' ? inputs.s : params.scalar;
    return applyVec3Op(params.op, vec3(inputs, 'a'), vec3(inputs, 'b'), s);
  },
};

/** The compute-node vocabulary, for bulk registration (registerAll.ts). */
export const COMPUTE_NODES: NodeDefinition[] = [
  MathNode as unknown as NodeDefinition,
  ClampNode as unknown as NodeDefinition,
  FitNode as unknown as NodeDefinition,
  MixNode as unknown as NodeDefinition,
  CurveRemapNode as unknown as NodeDefinition,
  NoiseNode as unknown as NodeDefinition,
  MakeVec3Node as unknown as NodeDefinition,
  VecBreak3Node as unknown as NodeDefinition,
  Vec3MathNode as unknown as NodeDefinition,
];

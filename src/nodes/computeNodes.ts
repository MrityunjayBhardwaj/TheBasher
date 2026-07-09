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
import {
  applyMathOp,
  clamp,
  curveRemap,
  fit,
  fractalNoise,
  lerp,
  MATH_OPS,
  type MathOp,
} from './valueMath';

const NUMBER_OUT = { out: { type: 'Number', cardinality: 'single' } } as const;
const num = (inputs: Record<string, unknown>, key: string): number =>
  (inputs[key] as number | undefined) ?? 0;

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

/** The compute-node vocabulary, for bulk registration (registerAll.ts). */
export const COMPUTE_NODES: NodeDefinition[] = [
  MathNode as unknown as NodeDefinition,
  ClampNode as unknown as NodeDefinition,
  FitNode as unknown as NodeDefinition,
  MixNode as unknown as NodeDefinition,
  CurveRemapNode as unknown as NodeDefinition,
  NoiseNode as unknown as NodeDefinition,
];

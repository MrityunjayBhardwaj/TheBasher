// transformNodes — a whole transform as a value in a compute graph (#1784).
//
// Blender's Geometry Nodes matrix nodes, on Basher's `Matrix4` socket, with rotations on the
// `Quaternion` socket. Both socket types were declared long before anything carried them; these
// are the first nodes that do. A transform is what an object's placement IS (translation ·
// rotation · scale), and it is the value the constraint stack is moving to (#1797), so a graph
// and the stack can hand each other one type.
//
// Unconnected inputs read as Blender's socket defaults: translation (0,0,0), rotation the
// identity, scale (1,1,1), a transform the identity. A value of the wrong shape on a wire reads
// the same way, so a node is evaluable before its sources are wired (as computeNodes.ts does).
//
// Pure and stateless, like the rest of the compute vocabulary. All math lives in
// src/core/math/transformMath.ts.
//
// REF: ref/sources/blender-transform-nodes-v5.1.1/node_fn_{combine,separate}_transform.cc,
//      node_fn_matrix_multiply.cc, node_fn_invert_matrix.cc, node_fn_transform_{point,
//      direction}.cc, node_fn_{euler_to_rotation,rotation_to_euler}.cc; issue #1784.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import { IDENTITY_QUAT } from './quatMath';
import type { Quat, Vec3 } from './types';
import {
  composeTransform,
  eulerToQuat,
  IDENTITY_MAT4,
  invertTransform,
  isMat4,
  isQuat,
  type Mat4,
  multiplyTransforms,
  quatToEuler,
  separateTransform,
  transformDirection,
  transformPoint,
} from '../core/math/transformMath';

const NO_PARAMS = z.object({});
type NoParams = Record<string, never>;

const MATRIX_OUT = { out: { type: 'Matrix4', cardinality: 'single' } } as const;
const VECTOR3_OUT = { out: { type: 'Vector3', cardinality: 'single' } } as const;
const QUAT_OUT = { out: { type: 'Quaternion', cardinality: 'single' } } as const;

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

const vec3 = (inputs: Record<string, unknown>, key: string, fallback: Vec3): Vec3 => {
  const v = inputs[key];
  return isVec3(v) ? v : fallback;
};
const quat = (inputs: Record<string, unknown>, key: string): Quat => {
  const v = inputs[key];
  return isQuat(v) ? v : IDENTITY_QUAT;
};
const mat4 = (inputs: Record<string, unknown>, key: string): Mat4 => {
  const v = inputs[key];
  return isMat4(v) ? v : IDENTITY_MAT4;
};

// ── Combine Transform — translation, rotation, scale → a transform ─────────────
export const CombineTransformNode: NodeDefinition<NoParams, Mat4> = {
  type: 'CombineTransform',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: {
    translation: { type: 'Vector3', cardinality: 'single', owns: 'always' },
    rotation: { type: 'Quaternion', cardinality: 'single', owns: 'always' },
    scale: { type: 'Vector3', cardinality: 'single', owns: 'always' },
  },
  outputs: MATRIX_OUT,
  evaluate: (_params, inputs) =>
    composeTransform(
      vec3(inputs, 'translation', [0, 0, 0]),
      quat(inputs, 'rotation'),
      vec3(inputs, 'scale', [1, 1, 1]),
    ),
};

// ── Separate Transform — a transform → translation, rotation, scale ────────────
export const SeparateTransformNode: NodeDefinition<
  NoParams,
  { translation: Vec3; rotation: Quat; scale: Vec3 }
> = {
  type: 'SeparateTransform',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: { transform: { type: 'Matrix4', cardinality: 'single', owns: 'always' } },
  outputs: {
    translation: { type: 'Vector3', cardinality: 'single' },
    rotation: { type: 'Quaternion', cardinality: 'single' },
    scale: { type: 'Vector3', cardinality: 'single' },
  },
  evaluate: (_params, inputs) => {
    const { translation, rotation, scale } = separateTransform(mat4(inputs, 'transform'));
    return { translation, rotation, scale };
  },
};

// ── Multiply Transforms — a · b (b applies first) ──────────────────────────────
export const MultiplyTransformsNode: NodeDefinition<NoParams, Mat4> = {
  type: 'MultiplyTransforms',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: {
    a: { type: 'Matrix4', cardinality: 'single', owns: 'always' },
    b: { type: 'Matrix4', cardinality: 'single', owns: 'always' },
  },
  outputs: MATRIX_OUT,
  evaluate: (_params, inputs) => multiplyTransforms(mat4(inputs, 'a'), mat4(inputs, 'b')),
};

// ── Invert Transform — the inverse; the identity when there is none (Blender) ──
export const InvertTransformNode: NodeDefinition<NoParams, Mat4> = {
  type: 'InvertTransform',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: { transform: { type: 'Matrix4', cardinality: 'single', owns: 'always' } },
  outputs: MATRIX_OUT,
  evaluate: (_params, inputs) => invertTransform(mat4(inputs, 'transform')) ?? IDENTITY_MAT4,
};

// ── Transform Point — move, turn and scale a point ─────────────────────────────
export const TransformPointNode: NodeDefinition<NoParams, Vec3> = {
  type: 'TransformPoint',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: {
    point: { type: 'Vector3', cardinality: 'single', owns: 'always' },
    transform: { type: 'Matrix4', cardinality: 'single', owns: 'always' },
  },
  outputs: VECTOR3_OUT,
  evaluate: (_params, inputs) =>
    transformPoint(mat4(inputs, 'transform'), vec3(inputs, 'point', [0, 0, 0])),
};

// ── Transform Direction — turn and scale a direction (no move) ─────────────────
export const TransformDirectionNode: NodeDefinition<NoParams, Vec3> = {
  type: 'TransformDirection',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: {
    direction: { type: 'Vector3', cardinality: 'single', owns: 'always' },
    transform: { type: 'Matrix4', cardinality: 'single', owns: 'always' },
  },
  outputs: VECTOR3_OUT,
  evaluate: (_params, inputs) =>
    transformDirection(mat4(inputs, 'transform'), vec3(inputs, 'direction', [0, 0, 0])),
};

// ── Euler to Rotation / Rotation to Euler — degrees, the order objects use ─────
export const EulerToRotationNode: NodeDefinition<NoParams, Quat> = {
  type: 'EulerToRotation',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: { euler: { type: 'Vector3', cardinality: 'single', owns: 'always' } },
  outputs: QUAT_OUT,
  evaluate: (_params, inputs) => eulerToQuat(vec3(inputs, 'euler', [0, 0, 0])),
};

export const RotationToEulerNode: NodeDefinition<NoParams, Vec3> = {
  type: 'RotationToEuler',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: NO_PARAMS,
  inputs: { rotation: { type: 'Quaternion', cardinality: 'single', owns: 'always' } },
  outputs: VECTOR3_OUT,
  evaluate: (_params, inputs) => quatToEuler(quat(inputs, 'rotation')),
};

/** The transform vocabulary, for bulk registration (registerAll.ts). */
export const TRANSFORM_NODES: NodeDefinition[] = [
  CombineTransformNode as unknown as NodeDefinition,
  SeparateTransformNode as unknown as NodeDefinition,
  MultiplyTransformsNode as unknown as NodeDefinition,
  InvertTransformNode as unknown as NodeDefinition,
  TransformPointNode as unknown as NodeDefinition,
  TransformDirectionNode as unknown as NodeDefinition,
  EulerToRotationNode as unknown as NodeDefinition,
  RotationToEulerNode as unknown as NodeDefinition,
];

// DAG type spine. Every node, every op, every project file goes through these.
//
// Discipline: ALL types ship with a zod schema. Loose `unknown` payloads are
// validated at the boundary they enter (op dispatch, project load, agent tool
// call) — never trusted past it.
//
// REF: THESIS.md §6-10 (the primitive), §50 (Op system is the only mutation
// path), App. A (glossary), App. B (Op shapes).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type NodeId = string;
export type SocketId = string;
export type NodeTypeId = string;

export const NodeIdSchema = z.string().min(1);
export const SocketIdSchema = z.string().min(1);
export const NodeTypeIdSchema = z.string().min(1);

// A reference to (node, socket). Used for both inputs and outputs.
export const NodeRefSchema = z.object({
  node: NodeIdSchema,
  socket: SocketIdSchema,
});
export type NodeRef = z.infer<typeof NodeRefSchema>;

// An input slot may carry either a single ref or a list (for sockets like
// Scene.children). The node-type's input schema declares which.
export const InputBindingSchema = z.union([NodeRefSchema, z.array(NodeRefSchema)]);
export type InputBinding = z.infer<typeof InputBindingSchema>;

// ---------------------------------------------------------------------------
// Type system across sockets (THESIS.md §8)
// ---------------------------------------------------------------------------

// V0.5 ships only the names; runtime uses nominal string equality. The full
// converter-node story (THESIS.md §8) lands in P1+.
export type SocketTypeName =
  | 'Number'
  | 'Vector2'
  | 'Vector3'
  | 'Quaternion'
  | 'Matrix4'
  | 'Color'
  | 'Boolean'
  | 'String'
  | 'Time'
  | 'Mesh'
  | 'Material'
  | 'Texture'
  | 'Image'
  | 'Camera'
  | 'Light'
  | 'Scene'
  | 'Group'
  | 'Transform'
  | 'RenderOutput'
  | 'NodeRef';

export type Cardinality = 'single' | 'list';

export interface TypeDescriptor {
  type: SocketTypeName;
  cardinality: Cardinality;
}

// ---------------------------------------------------------------------------
// Node definition (the contract every node-type implements)
// ---------------------------------------------------------------------------

export type NodeCost = 'cheap' | 'medium' | 'expensive';

export interface EvalCtx {
  time: { frame: number; seconds: number; normalized: number };
  seed?: number;
  realTime?: number;
}

export interface ResolvedInputs {
  [socket: string]: unknown;
}

export interface NodeDefinition<P = unknown, O = unknown> {
  type: NodeTypeId;
  version: number;
  pure: boolean;
  cost: NodeCost;
  paramSchema: z.ZodType<P>;
  inputs: Record<SocketId, TypeDescriptor>;
  outputs: Record<SocketId, TypeDescriptor>;
  /**
   * Pure functional evaluator. Must NOT read clocks, randomness, or globals
   * — V2/V3 enforced by lint in src/nodes/**. Time enters via a `Time` input
   * or via ctx for impure nodes only.
   */
  evaluate(params: P, inputs: ResolvedInputs, ctx: EvalCtx): O | Record<string, O>;
  /** Optional migration ladder: version N → N+1. */
  migrations?: Record<number, (oldParams: unknown) => unknown>;
}

// ---------------------------------------------------------------------------
// In-memory Node (a record in the DAG)
// ---------------------------------------------------------------------------

export const NodeSchema = z.object({
  id: NodeIdSchema,
  type: NodeTypeIdSchema,
  version: z.number().int().nonnegative(),
  params: z.unknown(),
  inputs: z.record(SocketIdSchema, InputBindingSchema),
  meta: z
    .object({
      name: z.string().optional(),
      position: z.tuple([z.number(), z.number()]).optional(),
    })
    .optional(),
});
export type Node = z.infer<typeof NodeSchema>;

// ---------------------------------------------------------------------------
// Op primitives (THESIS.md App. B)
// ---------------------------------------------------------------------------

export const OpAddNodeSchema = z.object({
  type: z.literal('addNode'),
  nodeId: NodeIdSchema,
  nodeType: NodeTypeIdSchema,
  params: z.unknown(),
  inputs: z.record(SocketIdSchema, InputBindingSchema).optional(),
});

export const OpRemoveNodeSchema = z.object({
  type: z.literal('removeNode'),
  nodeId: NodeIdSchema,
});

export const OpConnectSchema = z.object({
  type: z.literal('connect'),
  from: NodeRefSchema,
  to: NodeRefSchema,
});

export const OpDisconnectSchema = z.object({
  type: z.literal('disconnect'),
  from: NodeRefSchema,
  to: NodeRefSchema,
});

export const OpSetParamSchema = z.object({
  type: z.literal('setParam'),
  nodeId: NodeIdSchema,
  paramPath: z.string(),
  value: z.unknown(),
});

export const OpSchema = z.discriminatedUnion('type', [
  OpAddNodeSchema,
  OpRemoveNodeSchema,
  OpConnectSchema,
  OpDisconnectSchema,
  OpSetParamSchema,
]);
export type Op = z.infer<typeof OpSchema>;

// An op paired with the inverse needed to undo it.
export interface InverseOp {
  forward: Op;
  inverse: Op;
}

// A transactional set of ops (Diff system, P2.5; structure ships in P0 so
// the agent surface fits without a refactor later).
export const DiffSchema = z.object({
  id: z.string(),
  description: z.string(),
  ops: z.array(
    z.object({
      forward: OpSchema,
      inverse: OpSchema,
    }),
  ),
  status: z.enum(['proposed', 'previewing', 'applied', 'rejected']),
  source: z.enum(['user', 'agent', 'macro']),
  timestamp: z.number(),
});
export type Diff = z.infer<typeof DiffSchema>;

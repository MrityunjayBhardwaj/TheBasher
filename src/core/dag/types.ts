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
  | 'NodeRef'
  // P2 — Character + Move (THESIS.md §40)
  | 'Character'
  | 'Skeleton'
  | 'PosedSkeleton'
  | 'AnimationClip'
  // P7.5 — glTF TRS animation extraction (THESIS §42, issue #81)
  | 'TransformClip'
  | 'Navmesh'
  | 'WalkPath'
  | 'LocomotionState'
  // P3 — Timeline = animation nodes (THESIS §42)
  | 'KeyframeChannel'
  // Operator substrate — CHOP/constraints (epic #201, V58). Edge-less driver
  // type (like KeyframeChannel): the output exists for introspection, but a
  // constraint is enumerated + scene-layer resolved, never wired into the graph.
  | 'Constraint'
  | 'Shot'
  | 'Cut'
  // P3.1 — Animation import + retargeting (THESIS §42.1)
  | 'BoneNameMap'
  // P4 — Render graph = render nodes (THESIS §43)
  | 'JobResult'
  // P5 — AI Render Bridge (THESIS §28, §44)
  | 'Prompt'
  | 'Video'
  // P7.7 — glTF scene children → addressable DAG nodes (issue #91). An
  // addressing satellite, not a scene producer: GltfChild has no inputs/
  // outputs into the render graph (the name registers the type only).
  | 'GltfChild';

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
  /**
   * Output type widened to `unknown` for the input shape so zod schemas with
   * `.default()` (input may be undefined, output is filled) still satisfy
   * `z.ZodType<P, _, unknown>` — the boundary parses unknown bytes to a
   * defaulted P.
   */
  paramSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
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
  /**
   * P6 W4 — Inspector section convention (UI-SPEC §5.8 + §7.2). Lists
   * the section ids that apply to this node type, in display order.
   * The first entry is the *primary domain* (expanded by default);
   * subsequent entries default-collapse per §5.8.
   *
   * Loose `string[]` typing here keeps the DAG registry app-agnostic —
   * SectionId narrowing happens at the Inspector layer
   * (`src/app/inspectorSections.ts:isSectionId`). Nodes that omit
   * this field route to the raw-param fallback rendering (D-08 B).
   */
  inspectorSections?: readonly string[];
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
  /**
   * Optional insertion position for list-cardinality sockets. Default
   * (omitted) appends to the end — preserves the P0 behavior. Drag-reorder
   * (P1, scene tree) sets this to the new sibling index. THESIS.md App. B
   * lists five Op types; this is a parameter on `connect`, not a sixth
   * type.
   */
  index: z.number().int().nonnegative().optional(),
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

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
  // #231 — the UNIFIED scene-object socket. Every node that produces a thing
  // that can live in a scene (mesh, light, camera, group) outputs 'SceneObject',
  // and every scene-graph consumer (Scene/Group `children`, `lights`, `camera`,
  // Transform/MaterialOverride/modifier `target`, …) accepts it. This mirrors
  // Blender's "everything is an Object": lights & cameras become groupable /
  // parentable through the same `children` socket as meshes (V44 index-corr by
  // node id; renderer/outliner switch on `value.kind`). 'Mesh'/'Light'/'Camera'
  // below are SUPERSEDED by this (no node decl uses them after #231 Inc 1); kept
  // until a cleanup pass confirms zero references (Chesterton).
  | 'SceneObject'
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
  // NLA / Action Strips — motion-space layering (epic #283, docs/NLA-DESIGN.md).
  // Three EDGE-LESS sidecar kinds (like KeyframeChannel/Constraint): an `Action`
  // is a target-less relative-path channel bundle (author a "walk" once); a
  // `Strip` binds it to a concrete target with retime/blend/influence; a `Track`
  // is an ordered mute/solo container of strips. Outputs exist for introspection,
  // but they are enumerated + folded by the resolver scan, never wired by edge
  // (V57 pattern). REF: docs/NLA-DESIGN.md §3.3; vyapti V88 D2.
  | 'Action'
  | 'Strip'
  | 'Track'
  // Operator substrate — CHOP/constraints (epic #201, V58). Edge-less driver
  // type (like KeyframeChannel): the output exists for introspection, but a
  // constraint is enumerated + scene-layer resolved, never wired into the graph.
  | 'Constraint'
  // Studio lighting — a named, switchable lighting setup (epic #201, slice #208,
  // V58/V62). A `LightRig` groups its lights + owns the shared aim centre/radius;
  // a `LightProfileSelect` picks one rig by name (the ClipSelect pattern) to feed
  // the scene. All profiles stay co-resident in the DAG (V34); switching is one
  // param → keyframeable (V57).
  | 'LightRig'
  | 'Shot'
  | 'Cut'
  // The Compositor (After Effects-style layer timeline) — docs/COMPOSITOR-DESIGN.md.
  // A `Composition` holds an ordered list of `Layer`s (composite z-order); a Layer's
  // `source` input is the existing `Image` socket (any time-varying Image producer:
  // a MediaClip, a scene-render, a ComfyWorkflow, or a nested Composition). The
  // node-graph view is a deferred projection of these nodes (V34).
  | 'Composition'
  | 'Layer'
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

// #291 (Epic 1 Inc 0) — a spare parameter is an ad-hoc, node-authored param that
// lives OUTSIDE the node's fixed per-type `paramSchema` (the Houdini "spare parms"
// model). Keeping it in a separate collection is deliberate: the fixed schema stays
// STRICT (an undeclared real-param key is still stripped/rejected — typos surface),
// while spare params are validated by this ONE shared schema. The `type` tag drives
// promotion UI (Inc 3) and viewport-handle mapping (Inc 4); `value` is loosely typed
// here and refined per handle/driver at the consumer.
// #294 (Inc 3) — `promoted` surfaces this spare param in the scene-wide Controllers
// dock (decision D-3). Optional so ABSENT = not promoted (the default) → bare/Inc-0
// projects serialize byte-identical, no migration. Toggled through the SAME
// `setSpareParam` op (the whole {type,value,promoted} is re-set), so promote/unpromote
// is undo-safe with the existing inverse — no new op type. The dock is a pure V34 view:
// it scans `node.spare` for `promoted === true` and edits the value back through
// `setSpareParam`; there is NO second store of promoted refs to keep in sync.
// #295 (Inc 4) — `handle` OVERRIDES/REFINES the viewport handle for a promoted spare
// (decision D-4). Blender-grounded: a viewport gizmo is a pure VIEW that writes the
// SAME datum (`Gizmo.matrix_basis` is a world 4×4; a Geometry-Nodes gizmo "modifies
// the value in the socket") — so the handle is a second view over node.spare, never a
// second store (V34). The shape DEFAULTS from `type` (vec2/vec3 → point, float/int →
// slider); `handle` only overrides when the user wants a different shape (e.g. a float
// as a `dial`) or slider range/axis. Optional so ABSENT = the type default → byte-
// identical serialize for Inc-0..3 projects, no migration (mirrors `promoted`). Set
// through the SAME `setSpareParam` op (whole {type,value,promoted,handle} re-set),
// undo-safe with the existing inverse.
export const SpareHandleSchema = z.object({
  kind: z.enum(['point', 'slider', 'dial']),
  // Slider TRACK axis / dial plane NORMAL in the anchor's world frame. Absent → a
  // per-kind default ('x' for slider, 'y' for dial). Ignored by `point` (free 3D).
  axis: z.enum(['x', 'y', 'z']).optional(),
  // Slider range [min,max] the track maps over; absent → [0,1]. Ignored by point/dial
  // (point is an absolute offset, dial is degrees).
  min: z.number().optional(),
  max: z.number().optional(),
});
export type SpareHandle = z.infer<typeof SpareHandleSchema>;
export const SpareParamSchema = z.object({
  type: z.enum(['float', 'int', 'bool', 'string', 'vec2', 'vec3']),
  value: z.unknown(),
  promoted: z.boolean().optional(),
  handle: SpareHandleSchema.optional(),
});
export type SpareParam = z.infer<typeof SpareParamSchema>;

export const NodeSchema = z.object({
  id: NodeIdSchema,
  type: NodeTypeIdSchema,
  version: z.number().int().nonnegative(),
  params: z.unknown(),
  // #291 — optional spare-param collection keyed by name. ABSENT when a node has
  // no spare params (the overwhelming default) so existing projects serialize
  // byte-identical — no migration needed (mirrors `meta.hidden`, #227 S4).
  spare: z.record(z.string(), SpareParamSchema).optional(),
  inputs: z.record(SocketIdSchema, InputBindingSchema),
  meta: z
    .object({
      name: z.string().optional(),
      position: z.tuple([z.number(), z.number()]).optional(),
      // #227 S4 — per-object visibility. Absent/false = visible (the default, so
      // existing projects need no migration); true = hidden in the viewport AND
      // the render (the renderer skips it). Lives on meta, not a per-type param,
      // because every node kind can be hidden uniformly (like meta.name).
      hidden: z.boolean().optional(),
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

// #224 — rename. `meta.name` is the canonical user-facing label (what
// `nodeDisplayName`, the inspector header and the a11y summary resolve to:
// meta.name ?? id). It is NOT a param (it lives on `node.meta`, outside the
// per-type paramSchema), so renaming needs its own op rather than setParam.
// `name: undefined` CLEARS the override → the label falls back to the node id.
export const OpSetMetaSchema = z.object({
  type: z.literal('setMeta'),
  nodeId: NodeIdSchema,
  name: z.string().optional(),
});

// #227 S4 — visibility toggle. A dedicated op (not an `OpSetMeta` field) because
// setMeta's `name: undefined` means CLEAR — there's no way to say "set hidden,
// leave name untouched" in one op. `hidden` is an explicit boolean (no clear
// semantics); the apply normalizes `false` away to keep saves minimal.
export const OpSetHiddenSchema = z.object({
  type: z.literal('setHidden'),
  nodeId: NodeIdSchema,
  hidden: z.boolean(),
});

// #291 (Epic 1 Inc 0) — spare-param mutation. A dedicated op pair (not `setParam`)
// because spare params are validated by SpareParamSchema, NOT the node's fixed
// per-type paramSchema (which would strip them, the H28 mechanism). `setSpareParam`
// sets the WHOLE {type,value} under `key`; its inverse is either a `setSpareParam`
// back to the prior value (key existed) or a `removeSpareParam` (key was new).
export const OpSetSpareParamSchema = z.object({
  type: z.literal('setSpareParam'),
  nodeId: NodeIdSchema,
  key: z.string().min(1),
  param: SpareParamSchema,
});

export const OpRemoveSpareParamSchema = z.object({
  type: z.literal('removeSpareParam'),
  nodeId: NodeIdSchema,
  key: z.string().min(1),
});

export const OpSchema = z.discriminatedUnion('type', [
  OpAddNodeSchema,
  OpRemoveNodeSchema,
  OpConnectSchema,
  OpDisconnectSchema,
  OpSetParamSchema,
  OpSetMetaSchema,
  OpSetHiddenSchema,
  OpSetSpareParamSchema,
  OpRemoveSpareParamSchema,
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

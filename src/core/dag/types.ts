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
  // #361 (object↔data split, Phase 1) — the typed `data` socket. An `Object`
  // owns the transform and points, through this socket, at a data node that owns
  // geometry (later: camera/light data). Distinct from 'SceneObject': an
  // 'ObjectData' value carries NO transform and is not itself a scene child —
  // it is what an Object POINTS AT. See docs/OBJECT-DATA-SPLIT-DESIGN.md §3.1.
  | 'ObjectData'
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

/**
 * #608 — the ROLE a render pass plays, as distinct from the TYPE it emits. All
 * four passes emit `Image`; what separates them is what the image is OF.
 *
 * `'stylized'` is deliberately absent: it names an image that came out of a
 * workflow, not a pass rendered from the scene, and the one reader that cares
 * (`agent.render.summarizeStylized`) already asks a different question.
 */
export type PassRole = 'beauty' | 'depth' | 'normal' | 'id';

/**
 * What a PRODUCER emits on an output socket: exactly one type. A producer that
 * could emit either of two types is a different node, not a wider socket.
 *
 * #608 — `role` states, ON THE DECLARATION, which render pass this socket
 * produces. It is optional because most sockets have no role: absence means
 * "this output plays no part in the pass lane", which is a fact, not a gap.
 *
 * WHY IT LIVES HERE AND NOT ON THE BINDING. The role belongs to the PRODUCER: a
 * DepthPass is a depth pass wherever it is wired, so an edge-level role would be
 * able to express a contradiction (bound as depth here, normal there) that has no
 * meaning. One owner, one place it is stated.
 *
 * WHY IT IS FREE. A descriptor is CODE — recompiled from source on every load and
 * present in no save file. The alternative designs both moved a SocketId, which is
 * DATA: a producer's output socket id is persisted verbatim inside every binding
 * that points at it (`{"node":"n_beauty","socket":"out"}`), so renaming outputs by
 * role would have been a project-format migration. Measured, not assumed.
 *
 * ⚠️ THE ROLE IS NOT THE VALUE'S TAG. `ImageValue.passKind` still exists and still
 * drives renderer dispatch, output-path naming and the content hash. This field is
 * the GRAPH's answer to "which socket is the depth pass", readable without
 * evaluating anything; that one is the VALUE's answer. They agree today on every
 * producer, which is exactly why a test asserting agreement over the registry alone
 * would prove nothing (#608 step 3 mints the disagreement).
 */
export interface OutputDescriptor {
  type: SocketTypeName;
  cardinality: Cardinality;
  role?: PassRole;
}

/**
 * What a CONSUMER accepts on an input socket: one type, or a SET of them (#609).
 *
 * WHY THE TWO DESCRIPTORS ARE NOT ONE. They were the same interface, so the
 * connect gate was a SYMMETRIC comparison (`inputDesc.type !== outputDesc.type`)
 * for a relation that is not symmetric. An output HAS a type; an input ACCEPTS
 * types. Once that asymmetry is stated, "one role, several accepted types"
 * becomes sayable and the gate becomes a membership test.
 *
 * ⚠️ A SET IS NOT COERCION. `Number | Vector3` means the role receives whichever
 * was wired, UNCONVERTED — the consumer still discriminates at read time. It does
 * NOT mean a Number is broadcast to a Vector3. Conflating the two is how a type
 * system starts lying in a second way, and #609 ruled it out of scope.
 *
 * THAT RULING NOW HAS A REASON FROM SOURCE (#616). Blender declares exactly ONE
 * type per socket (`SocketDeclaration.socket_type`, a scalar enum) and solves this
 * same problem — one role, several incoming types — by IMPLICIT CONVERSION at the
 * link, with `float → float3` registered in its conversion table. So a set-valued
 * socket has no Blender precedent and our divergence is deliberate: their
 * conversions are lossy and directional (`float_to_bool`, `float_to_int`), and a
 * driver that broadcast a Number to `[n, n, n]` would silently drive all three axes
 * of a Vector3 target. We need to KNOW which type arrived. That is acceptance.
 * ⚠️ `is_multi_input` in Blender is multiple LINKS, not multiple types — it is our
 * `cardinality: 'list'`, and it is the thing a reader mistakes for a union.
 * Houdini stays OPAQUE (no public source); any claim about it here is recall.
 * Full trace with file:line: `ref/GROUND_TRUTH_BLENDER_NODE_SOCKET_TYPING.md`.
 *
 * ⚠️ READ THIS THROUGH `inputAccepts`/`acceptedTypes`, NEVER `desc.type ===`.
 * This is the one hazard the widening introduces and the compiler does NOT catch:
 * `desc.type === 'ObjectData'` still type-checks against the union — the two sides
 * overlap — and silently reads FALSE for a set-valued socket. Every predicate that
 * asked the question that way has been folded onto these helpers, with two residuals
 * that are deliberate:
 *   • `test-utils/splitKinds.ts` re-spells the membership test inline. Forced, not
 *     chosen — a gate in its own spec forbids a VALUE import of `core/dag` there, so
 *     it cannot call this function. The two answers are held together by an AGREEMENT
 *     gate in `splitKinds.registry.test.ts`, which runs both over synthetic set-valued
 *     defs the registry does not contain (#615). Do not close the gap by widening the
 *     import rule; it is load-bearing.
 *   • three test assertions (`materialLink`, `ParamDriver` ×2) still compare `.type`
 *     directly, because their job IS to pin a specific declared type. They should
 *     fail loudly if the socket they name ever becomes a set.
 */
/**
 * Two or more accepted types (#614). The TUPLE shape is the point: a set of one is a
 * second spelling of the scalar form — identical behaviour, two ways to say it, which is
 * how a declaration comes to be read one way and written the other — and a set of none is
 * a socket nothing can ever wire, whose rejection message names no types at all. Both are
 * COMPILE errors at the declaration site rather than a gate failing somewhere else.
 *
 * DISTINCTNESS cannot be said in the type, so it is checked at registration instead; see
 * `assertInputDescriptors` in `registry.ts`. That check is not redundant with this type:
 * every synthetic node definition in the suite is registered through an `as never` cast,
 * which erases exactly this constraint, so the runtime check is what covers them.
 */
export type AcceptedTypeSet = readonly [SocketTypeName, SocketTypeName, ...SocketTypeName[]];

export interface InputDescriptor {
  type: SocketTypeName | AcceptedTypeSet;
  cardinality: Cardinality;
}

/**
 * The types an input socket accepts, always as a set (one-element for the
 * ordinary single-type socket). The one place the two spellings collapse.
 */
export function acceptedTypes(desc: InputDescriptor): readonly SocketTypeName[] {
  return Array.isArray(desc.type) ? desc.type : [desc.type as SocketTypeName];
}

/**
 * Does this input socket accept a producer emitting `produced`? Takes `undefined` —
 * an absent socket accepts nothing — because every caller is asking about a socket
 * looked up by name, and `?.type === 'X'` is exactly the spelling that reads FALSE
 * on a set-valued socket while still compiling.
 */
export function inputAccepts(desc: InputDescriptor | undefined, produced: SocketTypeName): boolean {
  if (!desc) return false;
  return Array.isArray(desc.type) ? desc.type.includes(produced) : desc.type === produced;
}

// ---------------------------------------------------------------------------
// Node definition (the contract every node-type implements)
// ---------------------------------------------------------------------------

export type NodeCost = 'cheap' | 'medium' | 'expensive';

// ---------------------------------------------------------------------------
// THE DETERMINISM CONTRACT — three clauses, because the one-line version is false
//
// The sentence usually quoted is *same (inputs, params, time) → same output*. It is
// true for the pure lane and FALSE for the other two, so stating it alone gets it
// relied on where it does not hold. All three clauses:
//
//   1. PURE nodes (`pure: true`) — same (inputs, params, time) → same output.
//      Time is an explicit term of the cook, not something excluded from it: it
//      arrives as a typed `Time` socket value from TimeSource, so a pure consumer
//      stays bit-exact given its arguments.
//
//   2. STATEFUL nodes (`stateful: true` — Lag, Solver) — deterministic given a SEED
//      and an INTERVAL, not point-in-time. A single-frame evaluation of a lag is
//      the wrong answer, not an imprecise one; the real value needs the previous
//      output, produced by the replay seam. Determinism here is by contract, not
//      by purity. (The reference substrate's stateful channel operators behave the
//      same way, so this is a property of the problem, not of our implementation.)
//
//   3. GENERATIVE nodes (ComfyUIWorkflow) — deterministic given a PINNED SEED.
//      ⚠️ NOT ACHIEVABLE TODAY: ComfyUIWorkflow carries no seed param, so the same
//      tuple can produce different pixels. Stated as a known limitation rather than
//      implied to hold. Giving it a seed is its own slice.
//
// WHY `EvalCtx` CARRIES ONLY `time`, and why that is load-bearing.
// This is the one channel by which a nondeterministic term could reach a pure
// evaluator without going through params or inputs — i.e. without entering the
// cache key. Two fields were removed here (#576) precisely because they could:
//   • `realTime` — wall-clock. Present since the original DAG core commit, never
//     read by anything. Reading it would break clause 1 silently.
//   • `seed` — worse than redundant. A pure node's cache key contains NO ctx term
//     (see `evaluator.ts`, where `timePart` is added for impure nodes only), so a
//     seed passed through the context would never enter the key and two different
//     seeds would collide on one cache entry. A seed belongs in PARAMS, where it is
//     hashed, saved and undoable — `ScatterNode` already does this correctly with
//     `mulberry32(params.seed)`.
// Adding a field here re-opens that hole, so the shape is pinned by
// `determinismContract.gate.test.ts`.
// ---------------------------------------------------------------------------

export interface EvalCtx {
  time: { frame: number; seconds: number; normalized: number };
}

export interface ResolvedInputs {
  [socket: string]: unknown;
}

export interface NodeDefinition<P = unknown, O = unknown> {
  type: NodeTypeId;
  version: number;
  pure: boolean;
  /**
   * Epic 2 — the stateful eval-contract. A `stateful` node's output at frame N
   * depends on its output at frame N−1 (a first/second-order recurrence, e.g.
   * Lag/Spring), so its point-in-time `evaluate` CANNOT produce the real value —
   * that requires an interval. The true value is produced by the replay seam
   * (`src/app/statefulOps.ts`), which threads the previous output forward from a
   * known seed over the frame interval [seedFrame, N] and folds a channel value
   * whose `sample(t)` re-integrates deterministically (so a scrub replays the same
   * interval and lands the same value — H40 by contract, not by purity). The
   * node's own `evaluate` is a passthrough of its input (the degenerate value used
   * only if it is ever read point-in-time). Absent/false = the ordinary
   * point-in-time contract. Marker only; the machinery lives in the seam.
   */
  stateful?: boolean;
  cost: NodeCost;
  /**
   * Output type widened to `unknown` for the input shape so zod schemas with
   * `.default()` (input may be undefined, output is filled) still satisfy
   * `z.ZodType<P, _, unknown>` — the boundary parses unknown bytes to a
   * defaulted P.
   */
  paramSchema: z.ZodType<P, z.ZodTypeDef, unknown>;
  inputs: Record<SocketId, InputDescriptor>;
  outputs: Record<SocketId, OutputDescriptor>;
  /**
   * #396 — WHICH input carries the CHAIN: the spine a stack walks down, as opposed
   * to an ARGUMENT the graph wires and the stack steps past. Absent = this node is
   * not a chain node at all (a leaf producer, a poser, a sink).
   *
   * WHY IT HAS TO BE DECLARED RATHER THAN DERIVED. Basher is a Blender-shaped
   * modifier stack over a Houdini-shaped network, and the two references answer this
   * differently: Houdini makes input 0 the spine POSITIONALLY (inputs are ordered, so
   * no declaration is needed), while Blender's geometry-node graph has no spine at all
   * and its modifier stack is unary by construction — a second operand there is an
   * OBJECT POINTER, never a stack member. Our sockets are a NAMED record, so the
   * positional answer is unavailable, and we need the stack surface anyway. Naming the
   * spine is the one form that serves both: the stack reads it, the graph ignores it.
   *
   * The concept already existed — it was just spelled five times and declared nowhere:
   * `const TARGET = 'target'` in `operatorChain.ts` AND `operatorStack.ts`, a third
   * shape test in `sceneNodeActions.ts` (`'target' in def.inputs && 'out' in
   * def.outputs`), a fourth in `test-utils/splitKinds.ts`, and `exposeParams.ts`'s
   * `CHAIN_SOCKETS`, which names the concept out loud. Each was independently correct
   * while every operator happened to spell its spine `target`. The first operator with
   * a second same-typed input breaks that coincidence silently: it registers, connects
   * and evaluates, and every one of those five walkers keeps addressing whichever
   * socket is called `target` — measured, not predicted (see the spec).
   *
   * The type rule rides on this too. "An operator's output type equals its input type"
   * was only ever true of the SPINE; argument roles carry their own types and are
   * exempt. Stating the spine is what makes that sentence checkable.
   */
  chainInput?: SocketId;
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
  /**
   * #394 (PLAN-3 P6) — where each of this node's params RENDERS: param key →
   * section id. Declared beside the schema, because "which card does this param
   * belong on?" is a property of the node, not of a central table.
   *
   * It replaces a ~190-line if-chain (`paramToSection`) in which every arm was
   * gated on the node's declared sections precisely so that the same key could
   * mean different things on different nodes. Three keys genuinely collide today
   * — `color` (light vs material), `lookAt` (transform vs camera vs light) and
   * `roll` (transform vs camera) — and a per-node table resolves them by
   * construction instead of by ordering the arms correctly.
   *
   * A param with no entry here is UNROUTED: it renders in the raw fallback
   * bucket, which is visible, not hidden. An entry naming a section this node
   * does not declare is also treated as unrouted rather than honoured — the row
   * would otherwise be grouped under a card that never renders and disappear
   * entirely. `paramHome.gate.test.ts` fails on such an entry, so the runtime
   * degradation is a backstop and not the plan.
   *
   * Loose `string` typing for the same reason `inspectorSections` above is
   * loose: it keeps the DAG registry app-agnostic. SectionId narrowing happens
   * at the Inspector layer (`src/app/inspectorSections.ts`).
   */
  home?: Readonly<Record<string, string>>;
  /**
   * #421/#424 — the ID-REFERENCE UNIVERSE: every param on this node type that
   * holds ANOTHER node's id. This is the half of the graph that does NOT travel
   * on edges (V57 edge-less sidecars: channels, constraints, drivers, strips),
   * so the edge walk — and `removeNode`'s "still consumed by" guard
   * (`ops.ts:143`) — is blind to it. Declaring it here gives whole-node ops ONE
   * index to consult instead of each site hand-maintaining a list that goes
   * stale at the next node kind (the trap #421 calls out).
   *
   * DELIBERATELY SEPARATE FROM `refParams` below. That field is an AUTHORING
   * surface: every entry renders an Inspector picker and removes the raw row
   * (NPanel.tsx:2881-2896/2903). "This param holds a node id" and "the user should
   * pick it from a dropdown" are different questions that only coincide on 6 of
   * the 23 id-holding params. Folding them would (a) inject pickers nobody asked
   * for, (b) break `sourceTransform` — NodeRefField writes `{node}` wholesale
   * (NPanel.tsx:707), dropping the required `channel` — and (c) still not express
   * `Track.strips`, an ARRAY. Two concerns, two declarations.
   *
   * `path` is the param path, dot-notation for one level of nesting
   * (`sourceTransform.node`).
   *
   * `shape` is how the id is STORED:
   *   • 'id'     — a plain string param (`target`, `aimNode`, `curve`).
   *   • 'nested' — a string at `path` inside an object param (`sourceSpare.node`).
   *   • 'ref'    — a whole `{ node }` object param (`sourceTransformVec`).
   *   • 'idList' — an array of plain string ids (`Track.strips`).
   *
   * `role` is what the reference MEANS, which decides what a delete does to it:
   *   • 'subject'  — this node is OWNED BY the referent and is meaningless without
   *                  it (a channel's `target`, a constraint's constrained object).
   *                  Delete the referent → delete THIS node.
   *   • 'argument' — this node merely POINTS AT the referent, which exists
   *                  independently and is usually shared (the curve a Follow-Path
   *                  follows, the Action a Strip plays, a controller Null).
   *                  Delete the referent → CLEAR the ref; this node survives, inert.
   *
   * Getting `role` wrong is destructive in one direction: marking a shared
   * referent 'subject' means deleting ONE library asset cascade-deletes every node
   * that used it. When unsure, 'argument' is the recoverable answer.
   *
   * `owns` is the OTHER DIRECTION. `role` answers "the referent was deleted — what
   * happens to me?"; `owns` answers "I was deleted — what happens to the referent?".
   * A param can need both: `Track.strips` drops a member when that Strip is deleted
   * (role: 'argument') AND takes its strips with it when the Track itself is deleted
   * (owns: true), because `Track.strips` is the only route to a Strip anywhere
   * (layeredChannels.ts:174). Absent = deleting this node leaves the referent alone,
   * which is right for every shared referent (a curve, an Action, a controller).
   */
  idRefs?: readonly {
    path: string;
    shape: 'id' | 'nested' | 'ref' | 'idList';
    role: 'subject' | 'argument';
    owns?: true;
  }[];
  /**
   * Node-reference params — the general "pick a node" authoring surface (the
   * Blender object-picker / Houdini node-path-param idiom). Each entry names a
   * param that holds a reference to another node (e.g. a SampleGeometry's terrain,
   * a Solver's controller, a Follow-Path's curve). The Inspector renders a
   * `NodeRefField` dropdown for each — candidates filtered by `kind` — so the
   * relationship is authored through ONE general control instead of a bespoke
   * preset/picker per node type. Surfaced even when the ref is unset (an empty
   * picker), since an unset ref is absent (or an empty string) in live `node.params`.
   *
   * `kind` filters the candidate list: 'mesh' (geometry sources), 'transformable'
   * (a Null/scene object whose transform is read), 'curve' (a Curve the arc-length
   * sampler can consume), or 'any'. Loose typing keeps the DAG registry app-agnostic
   * — the Inspector owns the candidate resolution.
   *
   * `shape` is how the param STORES the reference:
   *   • 'ref' (default) — a `{ node: string }` object (SampleGeometry, Solver).
   *   • 'id'            — a plain string id (the constraint family: `TrackTo.aimNode`,
   *                       `FollowPath.curve`). These must stay strings because the
   *                       constraint enumeration compares them directly (`p.target`),
   *                       so the picker drives the raw id rather than wrapping it.
   */
  refParams?: Readonly<
    Record<
      string,
      { label?: string; kind: 'mesh' | 'transformable' | 'curve' | 'any'; shape?: 'id' | 'ref' }
    >
  >;
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
// #296 (S4) — the bespoke viewport-handle geometry (the Inc-4 `handle` field) is
// RETIRED in favour of the physical Null controller: a controller is a real scene
// object grabbed with the normal gizmo, and a param is driven from its transform
// channel (Blender's "Transform Channel" driver / Houdini `ch("../null/tx")`, V93).
// One controller idiom, not two. The spare dock + inspector spare authoring stay.
// #394 (PLAN-3 P7) — `home` is where a PROMOTED spare renders as an interface row in
// the inspector of the chain it drives. It is the promote twin of `NodeDefinition.home`
// (the per-node param→section table P6 landed), and it has to live HERE rather than
// there for one structural reason: a spare param is not a declared param of a type. It
// lives in `node.spare`, a bag explicitly disjoint from the fixed schema, so it never
// reaches `paramToSection` and inherits no routing. Promote must therefore say where the
// row goes, per instance, or the row has no home at all.
//
// ABSENT (and an unknown/undeclared section id) = UNROUTED, which is VISIBLE — the raw
// bucket, never a hidden row. Same degradation rule as `NodeDefinition.home`, and for the
// same reason: honouring a section that never renders would make the control VANISH,
// which is the one outcome a promoted interface element must not have.
//
// Optional, so every pre-P7 spare param serializes byte-identical — no migration, exactly
// as `promoted` (#294) was added. Loose `string` for the section, narrowed at the
// inspector layer (`isSectionId`), keeping the DAG registry app-agnostic like the two
// fields above it.
export const SpareParamSchema = z.object({
  type: z.enum(['float', 'int', 'bool', 'string', 'vec2', 'vec3']),
  value: z.unknown(),
  promoted: z.boolean().optional(),
  home: z
    .object({
      section: z.string(),
      order: z.number().optional(),
      label: z.string().optional(),
    })
    .optional(),
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

// exposeParams — the inspector as a PROJECTION of the node chain (#394, PLAN-3 P1).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
//
// Today the panel starts from `selectedId` and renders THAT node's params, so any value
// living elsewhere has to be FOUND — and every find is a chance to find the wrong layer.
// Three roads already ask that question three different ways (`resolveDataParamOwner` per
// param root, `resolveMaterialFieldOwner` per field, and the material editor not at all),
// and each is a separate opportunity for the same silent failure: the write succeeds
// against a masked layer and nothing changes on screen.
//
// The inversion is the fix. If rows are GENERATED FROM nodes, each carrying the
// `(nodeId, paramPath)` it came from, then writing is the identity function on provenance
// and there is nothing left to resolve. An ownership oracle is still needed — but only for
// callers that address an aggregate and hold no row (the agent, a mutator), which is a
// much smaller surface than "every write road".
//
// Houdini does not have this problem, and the reason is exactly provenance: its parameter
// pane addresses a NODE, and the cook is initiated from the node carrying the display flag
// (`ref/houdini/SOP.md:75`). *Which layer am I editing?* = the node you clicked. Basher is
// a hybrid — a Blender-shaped object-addressed inspector over a Houdini-shaped wired chain
// — so the oracle is the price of the hybrid, and the goal is to shrink it, not sharpen it.
//
// ── WHAT THIS STAGE DOES, AND DELIBERATELY DOES NOT ─────────────────────────────────
//
// P1 emits the projection and NOTHING consumes it yet. That is the point. The panel is
// large and its row-building has real asymmetries (see `panelRoleOf` below), so the only
// safe way to move it is to first prove the projection reproduces what it renders today,
// row for row and in order. That proof is `exposeParams.gate.test.ts`, and every later
// stage keeps it green.
//
// The walk covers MORE than the panel renders today — data-lane operators and one hop of
// linked producers. Those rows are carried, not shown; the UI opts into them at P3. The
// gate is therefore scoped to the two roles the panel does render (`'poser'` and
// `'base'`), and the extra origins are asserted separately.
//
// ── ORDER ───────────────────────────────────────────────────────────────────────────
//
// Rows come out in RENDER order — the selected node's rows, then the chain below it,
// then linked producers. Order is produced by the WALK, never by sorting on `depth`:
// the panel renders the poser BEFORE the base, which is descending depth, so a sort
// would silently invert the two blocks. `depth` is metadata for grouping WITHIN a
// section at P3 (where a base row and an operator row share the material card and the
// operator belongs on top), not the ordering key for the projection itself.
//
// REF: src/app/NPanel.tsx (`LinkedDataSections` and the main-node block — the two row
//      roads this reproduces), src/app/inspectorSectionBody.tsx (`sectionRowFilter`,
//      `controlOwnedRowKeys` — the shared decisions), src/app/operatorChain.ts (the one
//      chain walk); PLAN-3 §3; issues #394, #518.

import type { DagState } from '../core/dag/state';
import type { Node, NodeRef } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { canApplyTransform } from './animate/dispatchApplyTransform';
import { isSectionId, paramToSection, sectionsOf, type SectionId } from './inspectorSections';
import {
  controlOwnedRowKeys,
  makeSectionCtx,
  sectionRowFilter,
  type SectionCtx,
} from './inspectorSectionBody';
import {
  isDataLaneOperator,
  isMaterialLaneOperator,
  isPoserNode,
  resolveDataLaneBase,
  singleRef,
} from './operatorChain';
import {
  MATERIAL_FIELD_IR_PATH,
  MATERIAL_OVERRIDE_FIELDS,
  resolveMaterialFieldOwners,
} from './resolveMaterialFieldOwner';
import { resolveDataParamOwner } from './resolveDataParamOwner';
import { nodeDisplayName } from './sceneTreeWalk';
import type { MaterialOverrideField } from '../nodes/types';
// The enumeration lives in `operatorStack` (it needs `nodeDisplayName`); the WALK
// vocabulary lives in the leaf. Importing each from where it actually is keeps the leaf a
// leaf — `operatorStack` reaches `sceneTreeWalk`, which closes a cycle back to the
// ownership reach, which is why the split exists at all (#516).
import { enumerateOperatorStack } from './operatorStack';
import { spareSourceOf } from './paramDrivers';

/** Where a row's node sits relative to the selection. */
export type ExposedOrigin =
  /** The selected node itself — the Object that poses the chain. */
  | 'poser'
  /** A data-lane operator standing between the base and the poser. */
  | 'operator'
  /** The base data node the chain resolves to (what the panel calls the linked data). */
  | 'base'
  /** A producer wired into a socket of one of the above (a shared Material node). */
  | 'linked';

/** Where a row renders. `section: null` is the unrouted bucket the panel already has —
 *  a real destination, not an absence, which is why it is modelled rather than dropped. */
export interface ExposedHome {
  readonly section: SectionId | null;
  readonly order?: number;
  readonly label?: string;
}

/** A later layer that supplies a field this row also holds — see `maskedBy`. */
export interface MaskSource {
  /** The node that actually supplies the value the viewport draws. */
  readonly nodeId: string;
  /** That node's display name, for the label. */
  readonly label: string;
}

export interface DerivedParam {
  readonly kind: 'derived';
  /** ABSOLUTE, this instance. What a write uses. */
  readonly nodeId: string;
  /** Chain-relative and id-free. What a template stores — see `relPathOf`. */
  readonly relPath: string;
  /** Dotted param path on `nodeId`. */
  readonly paramPath: string;
  readonly home: ExposedHome;
  /** 0 = the base producer; higher = a later layer. Metadata, not the sort key. */
  readonly depth: number;
  readonly origin: ExposedOrigin;
  /**
   * Fields on this row whose value the viewport takes from ANOTHER node, keyed by the
   * full param path the surface addresses (`material.specular.roughness`, or the flat
   * `roughness` on an override operator).
   *
   * ── A LABEL, NEVER A REDIRECT ─────────────────────────────────────────────────────
   *
   * A masked row stays EDITABLE and its write still lands on its own node. Redirecting
   * the write is what makes the failure silent; saying so out loud makes the same fact
   * loud. This is deliberately NOT the driven-param treatment, which locks the field
   * (`NPanel.tsx` NumericField, `readOnly = driven`): a driven value is recomputed every
   * frame and the base is never read again, whereas a masked material field's base IS
   * the value the moment the operator is muted, removed, or its authored bit cleared.
   * The base is the layer below, not dead state — Houdini's rule, where an upstream node
   * is always editable and the display flag decides only what you SEE.
   *
   * ── WHY A MAP AND NOT A FLAG ──────────────────────────────────────────────────────
   *
   * Masking is per FIELD and a row is a container of fields: one row (`n_box_data |
   * material`) renders as eleven lobe widgets, and a sparse override can supply exactly
   * one of them. A boolean on the row would be wrong at both ends — it would grey a
   * whole material because one channel is forced, or say nothing because most are not.
   */
  readonly maskedBy?: Readonly<Record<string, MaskSource>>;
}

/** One param a promoted control drives. Carries the driver's OWN id alongside the target,
 *  because unbinding one drive of a 1:N control is an operation on that driver node —
 *  looking it back up from `(target, paramPath)` would be resolution where provenance is
 *  already exact ([[V142]]), and a band can legitimately hold more than one driver. */
export interface PromotedDrive {
  /** The driven node — ABSOLUTE, this instance. */
  readonly nodeId: string;
  /** The driven param path on that node. */
  readonly paramPath: string;
  /** The driven param's chain-relative address — what a template stores. */
  readonly relPath: string;
  /** The `ParamDriver` node carrying this drive. */
  readonly driverId: string;
}

/**
 * An interface element that is a REAL param: a promoted spare on a control node, pulled
 * into N driven params by N `ParamDriver`s (#394 P7, PLAN-3 §3.6).
 *
 * ── WHY THIS IS DERIVED FROM THE GRAPH AND NOT FROM A CURATION LIST ──────────────────
 *
 * Promote is an ADDITION to the graph, not a view over it: it writes a spare param and
 * one driver per drive, both of which already exist, are already persisted, already
 * undo-safe, and already fold through the shipped overlay rail. This row is read back OUT
 * of those two facts. A separate list of promoted refs would be a second store of the
 * same truth, and the Controllers dock (#294) deliberately avoided exactly that.
 *
 * ── 1:N IS THE SHAPE, NOT AN EXTENSION ──────────────────────────────────────────────
 *
 * `drives` is a list from the first line. One control driving one param is the degenerate
 * case of one driving many, and retrofitting the plural onto a singular field is how a
 * 1:N model ends up with a "primary" drive and N-1 second-class ones.
 *
 * ── HOME ────────────────────────────────────────────────────────────────────────────
 *
 * A spare param lives in `node.spare`, a bag explicitly disjoint from the fixed schema, so
 * it never reaches `paramToSection` and inherits NO routing from P6's per-node table.
 * Promote states the home; absent or unknown degrades to `section: null` — the unrouted
 * bucket, which is VISIBLE ([[V145]]).
 */
export interface PromotedParam {
  readonly kind: 'promoted';
  /** The node hosting the spare param that IS the control. */
  readonly controlNodeId: string;
  /** The spare-param key on that node. */
  readonly controlPath: string;
  /** Every param this control drives WITHIN the projected chain, in a deterministic,
   *  id-free order (`relPath`). A drive onto a node outside this chain is real but is not
   *  this selection's interface, so it is not carried here. */
  readonly drives: readonly PromotedDrive[];
  readonly home: ExposedHome;
}

/** The union is declared as a union (rather than a struct with optional fields) so 1:N is
 *  not retrofitted, and so every consumer is compiler-forced to say which arm it means. */
export type ExposedParam = DerivedParam | PromotedParam;

/**
 * Rows regrouped the way a panel draws them: per section, plus the unrouted bucket.
 *
 * Lives here rather than in the panel because BOTH inspector blocks need it and a second
 * spelling is a second answer. Order within each bucket is the projection's own order,
 * which is the panel's order — see the ORDER note in the header.
 *
 * 🔴 THE BUCKETS CARRY ROWS, NOT PARAM PATHS, AND THAT IS THE POINT (#518, P3). This
 * function used to reduce each row to its `paramPath`, which threw the `nodeId` away and
 * forced the caller to re-attach ONE node id to every row it drew. That was harmless only
 * while every row in a block came from a single node — and the material lane ends that:
 * an operator's rows and the base's rows share the material section. Reduced to strings
 * they would all have been drawn against the base, so editing an operator's field would
 * have written to the node underneath it and changed nothing on screen. Provenance is
 * exact and resolution is inference; a regroup that drops the exact half is where the
 * inference gets reintroduced.
 *
 * GENERIC IN THE ROW, and deliberately so (#394 P7). Bucketing by `home` is the one thing
 * both arms of `ExposedParam` genuinely share, so widening the union did NOT force this
 * function — the compiler would have accepted it operating on the union and handing back
 * rows a caller then reads as derived. Taking the row type as a parameter makes the
 * narrowing the CALLER already did survive the call, so the panel's derived-only block
 * cannot be handed a promoted row by this seam.
 */
export function groupExposedRows<T extends { readonly home: ExposedHome }>(
  rows: readonly T[],
): {
  bySection: ReadonlyMap<SectionId, T[]>;
  unrouted: T[];
} {
  const bySection = new Map<SectionId, T[]>();
  const unrouted: T[] = [];
  for (const r of rows) {
    if (r.home.section === null) {
      unrouted.push(r);
      continue;
    }
    const list = bySection.get(r.home.section);
    if (list) list.push(r);
    else bySection.set(r.home.section, [r]);
  }
  return { bySection, unrouted };
}

/**
 * Which inspector block draws each promoted control (#394 P7).
 *
 * Lives beside {@link groupExposedRows} and for the same reason: TWO blocks draw section
 * cards — the selected node's own sections and the linked data node's — and a per-block
 * filter cannot rule out the two failures that matter. If both blocks decide independently,
 * a section both declare draws the control TWICE, and a section neither declares draws it
 * ZERO times. Neither is visible from inside a block, because a block can only see the
 * cards it draws itself.
 *
 * The rule: the selected node's declared sections win, the linked block takes the rest, and
 * anything neither can place is UNPLACED — which the panel renders in a visible bucket, not
 * a dropped row ([[V145]] reaching the interface layer). A control is the one row whose
 * disappearance also strands something: its drives keep pulling with no handle left to
 * reach them by.
 *
 * `ownSections` is the selected node's declared list; `hasLinkedBlock` says whether a linked
 * data block is being drawn at all. Both are facts the PANEL holds and neither block does,
 * which is why the partition is computed there and passed down.
 */
export function partitionPromotedRows(
  rows: readonly PromotedParam[],
  ownSections: readonly SectionId[],
  hasLinkedBlock: boolean,
): { main: PromotedParam[]; linked: PromotedParam[]; unplaced: PromotedParam[] } {
  const main: PromotedParam[] = [];
  const linked: PromotedParam[] = [];
  const unplaced: PromotedParam[] = [];
  for (const row of rows) {
    const section = row.home.section;
    if (section !== null && ownSections.includes(section)) main.push(row);
    else if (section !== null && hasLinkedBlock) linked.push(row);
    else unplaced.push(row);
  }
  return { main, linked, unplaced };
}

/** One node's position in the chain, addressed WITHOUT its id.
 *
 *  `nodeId` is per-instance: a template mints fresh ids every time it is instantiated, so
 *  any curation keyed on an id breaks the second time it is used. Houdini's rule applies
 *  verbatim — resolve by stable path against a flat namespace, never by walking a
 *  structure.
 *
 *  Operators are numbered from the BASE upward on purpose. Adding a modifier puts it at
 *  the TOP of the stack, so numbering from the base leaves every existing slot untouched;
 *  numbering from the poser would renumber the whole chain on every add.
 *
 *  DECLARED LIMIT: inserting an operator BELOW an existing one still shifts the slots
 *  above it. Blender and Houdini have the same property for stack indices; closing it
 *  needs a per-operator stable id, which is #454's axis, not this one. */
type Slot = string;

const SELF: Slot = 'self';
const BASE: Slot = 'base';

function opSlot(indexFromBase: number): Slot {
  return `op${indexFromBase}`;
}

/** `<slot>/<paramPath>`, or `<slot>.<socket>/<paramPath>` for a linked producer. */
function relPathOf(slot: Slot, paramPath: string): string {
  return `${slot}/${paramPath}`;
}

/** The panel's own binding check, reproduced. Deliberately identical, INCLUDING that it
 *  does not recognise a LIST binding (`[{node,socket}]`): edges live in `node.inputs`, not
 *  in params, so this guard is defensive at both sites and must not diverge between them. */
function isInputBinding(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<NodeRef>;
  return typeof o.node === 'string' && typeof o.socket === 'string';
}

/**
 * The two row-building roles the panel has, and they are NOT the same function.
 *
 * Measured at `NPanel.tsx` before this module was written, because reproducing the
 * difference is most of the work:
 *
 * | | main-node block (`:3016`) | `LinkedDataSections` (`:2691`) |
 * |---|---|---|
 * | ref params | skipped before grouping | not skipped |
 * | control-owned keys | skipped before grouping (union over ALL declared sections) | not skipped; only the per-section `omitted` filter applies |
 * | no declared sections | falls back to a FLAT list of every param | renders NOTHING at all |
 *
 * ⚠️ MEASURED, AND THE HONEST STATUS IS "REAL BUT CURRENTLY UNREACHABLE." Collapsing the
 * two roles into one function does NOT redden the gate — falsified by doing exactly that.
 * The reason is that no node type which can occupy the linked-data role can trigger any of
 * the three differences today:
 *
 *   · `slotIndex` is the only control-owned key routing to NO section, and its only owner
 *     is `MaterialOverride` — a scene-band wrapper (`SceneObject → SceneObject`), so it can
 *     never be a base data node.
 *   · every `refParams` declarer is a constraint or a query node (`FollowPath`, `TrackTo`,
 *     `Solver`, `geometryQuery`), none of which is a data node either.
 *   · every data node type declares at least one section, so the "renders nothing" arm has
 *     no subject.
 *
 * So the difference is reproduced because it is what the code DOES and because the moment a
 * data node owns a control-owned unrouted key it becomes observable — not because a test
 * proves it matters. Stated here rather than left implied: an untested difference that
 * reads as tested is worse than one that is written down.
 */
type PanelRole = 'main' | 'linked';

interface NodePlan {
  readonly node: Node;
  readonly role: PanelRole;
  readonly origin: ExposedOrigin;
  readonly slot: Slot;
  readonly depth: number;
}

/** Every row one node contributes, in the order the panel renders them: each declared
 *  section in declaration order, then that node's unrouted bucket. */
function rowsForNode(
  state: DagState,
  plan: NodePlan,
  objectNodeId: string,
  canApply: boolean,
): DerivedParam[] {
  const { node, role, origin, slot, depth } = plan;
  const declared = sectionsOf(state, node.id);
  const params = (node.params ?? {}) as Record<string, unknown>;
  const ctx: SectionCtx = makeSectionCtx(node, objectNodeId, canApply);

  const emit = (paramPath: string, section: SectionId | null): DerivedParam => ({
    kind: 'derived',
    nodeId: node.id,
    relPath: relPathOf(slot, paramPath),
    paramPath,
    home: { section },
    depth,
    origin,
  });

  // A node that declares nothing. The two roles disagree, and both are reproduced.
  if (declared.length === 0) {
    if (role === 'linked') return []; // LinkedDataSections returns null outright
    const refKeys = refKeysOf(node);
    // The raw-fallback path filters ref params and NOTHING else — not even bindings.
    return Object.keys(params)
      .filter((key) => !refKeys.has(key))
      .map((key) => emit(key, null));
  }

  const refKeys = refKeysOf(node);
  const ownedRowKeys = role === 'main' ? controlOwnedRowKeys(declared, ctx) : new Set<string>();

  const grouped = new Map<SectionId, string[]>();
  const unrouted: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (isInputBinding(value)) continue;
    if (role === 'main' && refKeys.has(key)) continue;
    if (ownedRowKeys.has(key)) continue;
    const section = paramToSection(key, declared, node.type);
    if (section === null) {
      unrouted.push(key);
      continue;
    }
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section)!.push(key);
  }

  const out: DerivedParam[] = [];
  for (const sectionId of declared) {
    // The same filter `SectionBody` renders through — a control that replaces its rows
    // must suppress them here too, or the projection claims rows the panel does not draw.
    const { suppressAllRows, omitted } = sectionRowFilter(sectionId, ctx);
    if (suppressAllRows) continue;
    for (const key of grouped.get(sectionId) ?? []) {
      if (omitted.has(key)) continue;
      out.push(emit(key, sectionId));
    }
  }
  for (const key of unrouted) out.push(emit(key, null));
  return out;
}

/** The ref params a node declares — rendered in their own picker block above the sections,
 *  so they are not section rows on the main road. */
function refKeysOf(node: Node): ReadonlySet<string> {
  const meta = getNodeType(node.type)?.refParams;
  return meta ? new Set(Object.keys(meta)) : new Set<string>();
}

/** The sockets that carry the chain itself, which must never be followed as if they were
 *  linked producers — they ARE the chain, and are walked as such. */
const CHAIN_SOCKETS: ReadonlySet<string> = new Set(['data', 'target', 'out']);

/** Producers wired into `node`'s non-chain input sockets, one hop.
 *
 *  ONE HOP, deliberately: a Material node feeding `BoxData.material` is the case that
 *  exists, and an unbounded walk would pull an entire upstream subgraph into an object's
 *  inspector. Deepening this is a decision with its own evidence, not a default. */
function linkedProducers(state: DagState, node: Node): { node: Node; socket: string }[] {
  const out: { node: Node; socket: string }[] = [];
  for (const [socket, binding] of Object.entries((node.inputs ?? {}) as Record<string, unknown>)) {
    if (CHAIN_SOCKETS.has(socket)) continue;
    const refs = (Array.isArray(binding) ? binding : [binding]) as (NodeRef | undefined)[];
    for (const ref of refs) {
      const producer = ref?.node ? state.nodes[ref.node] : undefined;
      if (producer) out.push({ node: producer, socket });
    }
  }
  return out;
}

/**
 * Every param the inspector could show for `selectedId`, each carrying the node it came
 * from — so a write is the identity function on provenance rather than a second lookup.
 *
 * Pure. No React, no store. The panel, the agent query and the channel roads are all
 * meant to read this one projection; P1 ships it with no consumer so the byte-identical
 * gate can be established before anything moves.
 */
export function exposeParams(
  state: DagState,
  selectedId: string | null | undefined,
  opts?: {
    /** `canApplyTransform(state, selectedId)`, when the caller has already computed it.
     *
     *  Not a convenience. That predicate EVALUATES the node, and the inspector already
     *  computes it for its own section context on every render — so without this the panel
     *  would evaluate a third time per render purely to build the projection. #498 measured
     *  and deliberately kept two; a third would be a regression paid for nothing. Omitted,
     *  the projection computes it itself, which is what every non-UI caller wants. */
    canApply?: boolean;
  },
): ExposedParam[] {
  const selected = selectedId ? state.nodes[selectedId] : undefined;
  if (!selected) return [];

  const canApply = opts?.canApply ?? canApplyTransform(state, selected.id);

  // The chain below the selection: base ← op₀ … opₙ ← poser. `resolveDataLaneBase` is
  // identity for a node with no data lane, which is how a non-poser selection (a channel,
  // a Material node, an operator selected directly) resolves to just itself.
  const base = resolveDataLaneBase(state, selected.id);
  const hasLane = base !== selected.id && isPoserNode(selected) && !!singleRef(selected, 'data');
  const operators = hasLane
    ? enumerateOperatorStack(state, base, isDataLaneOperator).map((e) => state.nodes[e.nodeId])
    : [];

  const plans: NodePlan[] = [];
  const poserDepth = operators.length + 1;
  plans.push({
    node: selected,
    role: 'main',
    origin: 'poser',
    slot: SELF,
    depth: hasLane ? poserDepth : 0,
  });
  // Render order is poser → down the chain, which is DESCENDING depth. Emitting in walk
  // order rather than sorting is what keeps that faithful to the panel.
  for (let i = operators.length - 1; i >= 0; i--) {
    const op = operators[i];
    if (!op) continue;
    plans.push({ node: op, role: 'linked', origin: 'operator', slot: opSlot(i), depth: i + 1 });
  }
  if (hasLane) {
    const baseNode = state.nodes[base];
    if (baseNode) {
      plans.push({ node: baseNode, role: 'linked', origin: 'base', slot: BASE, depth: 0 });
    }
  }

  const out: DerivedParam[] = [];
  // Every node the projection covers, with the slot it occupies — the map the promoted
  // walk needs to give a driven param its chain-relative address. Built HERE, from the
  // same walk that emits the rows, so a control can never report a slot the projection
  // does not actually contain.
  const slotOf = new Map<string, Slot>();
  for (const plan of plans) {
    slotOf.set(plan.node.id, plan.slot);
    out.push(...rowsForNode(state, plan, selected.id, canApply));
    // …then whatever is wired INTO that node, one hop, at the same layer.
    for (const { node: producer, socket } of linkedProducers(state, plan.node)) {
      const slot = `${plan.slot}.${socket}`;
      slotOf.set(producer.id, slot);
      out.push(
        ...rowsForNode(
          state,
          {
            node: producer,
            role: 'linked',
            origin: 'linked',
            slot,
            depth: plan.depth,
          },
          selected.id,
          canApply,
        ),
      );
    }
  }

  // Promoted controls come FIRST. They are the top of the declared precedence ladder —
  // a driven param takes its value from the control, not from its own row — so the
  // interface reads above the layers it drives, exactly as the topmost operator does.
  // The derived rows keep their walk order untouched behind them, which is what keeps
  // the byte-identical gate (§5 gate 1) comparing the same list it always did.
  return [
    ...promotedRowsFor(state, slotOf),
    ...withMaterialMasking(state, selected.id, plans, out),
  ];
}

/**
 * The promoted controls whose drives land inside this projection (#394 P7).
 *
 * Read back out of the graph, never out of a list: a control IS a promoted spare param
 * plus the `ParamDriver`s pulling from it. That is the whole model — see {@link
 * PromotedParam}.
 *
 * ⚠️ `promoted === true` IS REQUIRED, and it is the discriminator, not a filter. The
 * spare road (#294) is also how an ordinary, un-promoted knob drives a param; such a
 * driver is a relation between two nodes and has no business appearing as an interface
 * row in a third node's inspector. The flag is the existing, shipped answer to "is this
 * spare an interface element?" — the Controllers dock is built on the same one, so a
 * control cannot be in the dock and absent here, or the reverse.
 *
 * PURE and params-only: no evaluate, no store. This runs inside the panel's memo on every
 * projection.
 */
function promotedRowsFor(state: DagState, slotOf: ReadonlyMap<string, Slot>): PromotedParam[] {
  const byControl = new Map<string, { nodeId: string; key: string; drives: PromotedDrive[] }>();

  for (const driver of Object.values(state.nodes)) {
    const spare = spareSourceOf(driver);
    if (!spare) continue;
    const params = (driver.params ?? {}) as { target?: unknown; paramPath?: unknown };
    const target = params.target;
    const paramPath = params.paramPath;
    if (typeof target !== 'string' || typeof paramPath !== 'string' || !target || !paramPath) {
      continue;
    }
    const slot = slotOf.get(target);
    if (slot === undefined) continue; // drives something outside this chain
    if (state.nodes[spare.node]?.spare?.[spare.key]?.promoted !== true) continue;

    const id = `${spare.node}::${spare.key}`;
    let entry = byControl.get(id);
    if (!entry) {
      entry = { nodeId: spare.node, key: spare.key, drives: [] };
      byControl.set(id, entry);
    }
    entry.drives.push({
      nodeId: target,
      paramPath,
      relPath: relPathOf(slot, paramPath),
      driverId: driver.id,
    });
  }

  const rows: PromotedParam[] = [];
  for (const { nodeId, key, drives } of byControl.values()) {
    // Deterministic and id-free: `Object.values(state.nodes)` is table order, which is an
    // authoring accident. Sorting on the chain-relative address means the same chain
    // instanced twice lists its drives identically — the property `relPath` exists for.
    drives.sort(
      (a, b) => a.relPath.localeCompare(b.relPath) || a.driverId.localeCompare(b.driverId),
    );
    const declaredHome = state.nodes[nodeId]?.spare?.[key]?.home;
    // An unknown section id degrades to the unrouted bucket rather than being honoured:
    // a card that never renders would take the control off screen entirely ([[V145]]).
    const section = declaredHome && isSectionId(declaredHome.section) ? declaredHome.section : null;
    rows.push({
      kind: 'promoted',
      controlNodeId: nodeId,
      controlPath: key,
      drives,
      home: {
        section,
        ...(declaredHome?.order !== undefined ? { order: declaredHome.order } : {}),
        ...(declaredHome?.label !== undefined ? { label: declaredHome.label } : {}),
      },
    });
  }
  rows.sort(
    (a, b) =>
      (a.home.order ?? 0) - (b.home.order ?? 0) ||
      a.controlNodeId.localeCompare(b.controlNodeId) ||
      a.controlPath.localeCompare(b.controlPath),
  );
  return rows;
}

/**
 * Attach `maskedBy` to the rows a later layer supplies (#394 P4).
 *
 * ⚠️ ONCE PER PROJECTION, NEVER PER ROW — the measured trap this stage carries.
 * `resolveMaterialFieldOwners` EVALUATES to learn which source maps defend a channel, and
 * the evaluator hashes params before its cache lookup ([[H48]]; the ~458ms inspector edit
 * lag #498 measured). One call answers all six fields for the whole chain, and its result
 * is distributed over the rows here. A per-row call would evaluate once per widget, and
 * one material row is ELEVEN widgets.
 *
 * The guard in front of it matters as much: a chain with nothing that can mask pays
 * NOTHING, which is every object in the default project.
 */
function withMaterialMasking(
  state: DagState,
  selectedId: string,
  plans: readonly NodePlan[],
  rows: readonly DerivedParam[],
): DerivedParam[] {
  // Two things can take authority over a material field: an operator in the lane, and a
  // producer wired into a `material` socket (a socket SUPERSEDES the param it shares a
  // name with — the rule `resolveDataParamOwner`'s second hop already encodes).
  const canMask = plans.some(
    (p) => isMaterialLaneOperator(p.node) || singleRef(p.node, 'material') !== null,
  );
  if (!canMask) return rows as DerivedParam[];

  const owners = resolveMaterialFieldOwners(state, selectedId);
  const labelOf = (nodeId: string) => {
    const n = state.nodes[nodeId];
    return n ? nodeDisplayName(n) : nodeId;
  };

  return rows.map((row) => {
    // Where would a material field live on THIS row? Exactly two vocabularies, which is
    // the same bridge `MATERIAL_FIELD_IR_PATH` exists for: a data node or a Material node
    // holds every field inside one `material` IR param; an override operator holds each
    // as a flat scalar param of its own. A row in neither shape holds no material field.
    const pathOn = (field: MaterialOverrideField): string | null =>
      row.paramPath === 'material'
        ? MATERIAL_FIELD_IR_PATH[field]
        : row.paramPath === field
          ? field
          : null;

    const masked: Record<string, MaskSource> = {};
    for (const field of MATERIAL_OVERRIDE_FIELDS) {
      const owner = owners[field];
      // Owned by this very row's node ⇒ nothing masks it. That is the common case and
      // the reason an unmasked row is byte-identical to before this stage.
      if (!owner || owner.nodeId === row.nodeId) continue;
      const path = pathOn(field);
      if (path === null) continue;
      masked[path] = { nodeId: owner.nodeId, label: labelOf(owner.nodeId) };
    }
    return Object.keys(masked).length > 0 ? { ...row, maskedBy: masked } : row;
  });
}

// ────────────────────────────────────────────────────────────────────────────────────
// THE OWNERSHIP QUERY — for callers that hold no row (#394 P5, #519)
// ────────────────────────────────────────────────────────────────────────────────────

/** The node a write / channel / driver for one logical param must land on, and the path
 *  it is called by THERE. Same shape as the per-field material owner it replaces, because
 *  the vocabulary bridge is the reason the path has to travel with the id. */
export interface ExposedTarget {
  readonly nodeId: string;
  readonly paramPath: string;
}

/** The IR path → override-field direction of `MATERIAL_FIELD_IR_PATH`. Derived from the
 *  one table rather than written out, so the two cannot drift. */
const MATERIAL_FIELD_BY_IR_PATH: Readonly<Record<string, MaterialOverrideField>> =
  Object.fromEntries(MATERIAL_OVERRIDE_FIELDS.map((f) => [MATERIAL_FIELD_IR_PATH[f], f])) as Record<
    string,
    MaterialOverrideField
  >;

/** The top-level param key of a path: 'material.base.color' → 'material'. */
function paramRootOf(paramPath: string): string {
  const dot = paramPath.indexOf('.');
  return dot === -1 ? paramPath : paramPath.slice(0, dot);
}

/**
 * Where `requested` lives on `row`, or null when this row does not hold it.
 *
 * Two vocabularies, and the bridge between them is deliberately NARROW. A data node or a
 * Material node holds every material channel inside one `material` IR param, so a request
 * for `material.base.color` is served by the `material` row under its own name. A material
 * override OPERATOR holds each channel as a flat scalar (`color`), so the same request is
 * served by a row whose path is just the field name.
 *
 * 🔴 THE BRIDGE IS SCOPED TO MATERIAL-LANE OPERATORS, AND THAT SCOPE IS LOAD-BEARING.
 * `color` is not a rare param name — a LightData owns one, and so does any future node that
 * happens to spell a channel flat. Bridging on the name alone would make
 * `material.base.color` resolve onto a split light's `color` row, quietly turning a mutator
 * that reports "this target has no material" into one that writes the light. Asking whether
 * the row's node is a material operator is the same question the flat vocabulary comes from,
 * so it cannot drift from it.
 */
function pathOnRow(state: DagState, row: DerivedParam, requested: string): string | null {
  if (requested === row.paramPath || requested.startsWith(`${row.paramPath}.`)) return requested;
  const field = MATERIAL_FIELD_BY_IR_PATH[requested];
  if (field === undefined || row.paramPath !== field) return null;
  return isMaterialLaneOperator(state.nodes[row.nodeId]) ? field : null;
}

/**
 * The topmost entry for a logical param that nothing above it supplies — the ONE ownership
 * answer for callers that address an aggregate and hold no row (#394 P5, closing #519).
 *
 * ── WHY THIS EXISTS AND WHAT IT REPLACES ────────────────────────────────────────────
 *
 * A surface that generated its rows FROM nodes needs no query: the row carries the node it
 * came from, and writing is the identity function on provenance. The agent has no row. It
 * names a scene object and a param path, and something has to say which layer of the chain
 * that path resolves to — per FIELD, because a material override operator authors a sparse
 * per-field set, and per LAYER, because the answer for `color` can be the operator while the
 * answer for `roughness` is still the material node underneath.
 *
 * Resolving per param ROOT is what #519 measured: the whole `material` root resolved to the
 * layer at the bottom, so a channel created for a colour an operator forces was placed on
 * the masked layer. It reported success, the dopesheet drew the curve, and the composed
 * material took that field from the operator above.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────
 *
 * Walk the projection in its own order — poser, then the lane from the TOP down, then the
 * producers wired into each — and take the first row that holds the field and is not marked
 * as supplied by someone else. A masked row is skipped rather than followed, because its
 * masker is a row of its own; that is what keeps this an answer ABOUT the projection rather
 * than a second walk beside it.
 *
 * ⚠️ THE FALLBACK IS NOT DEFENSIVE — IT IS LOAD-BEARING, AND IT IS MEASURED. A param a
 * custom control renders has NO projection row at all: `fov`, `near`, `far` and six more are
 * omitted for the camera lens control, `points` for the curve editor, the channel modifier
 * keys for their stack. The projection is the panel's generic rows, and those params are not
 * generic rows. Falling through to the per-root reach keeps this a strict EXTENSION of the
 * shipped answer rather than a narrower replacement — which is what a bare `?? id` at the
 * call site would silently have made it (a camera channel would have gone back to targeting
 * the Object, where the render overlay never collects it).
 *
 * ⚠️ THIS EVALUATES — `canApplyTransform` for the section context, and the masking walk when
 * the chain has a layer that can mask. Call it from a mutator's `build`/`preconditions`, never
 * from a zustand selector ([[H48]]).
 */
export function resolveExposedTarget(
  state: DagState,
  id: string,
  paramPath: string,
): ExposedTarget | null {
  for (const row of exposeParams(state, id)) {
    // A PROMOTED CONTROL IS NOT AN ANSWER TO THIS QUESTION. The caller asked which LAYER
    // of this chain owns a path; a control is a spare param on another node, with its own
    // type and range, and answering with it would be the redirect [[V143]] forbids —
    // `setParam('roughness')` landing on a knob merely NAMED `roughness` because it drives
    // the real one, with nothing in the return value to say so.
    //
    // ⚠️ MEASURED, AND THE HONEST STATUS IS "ENFORCED BY THE COMPILER, NOT BY THIS LINE."
    // Deleting the skip does not redden a single test — it is a COMPILE error (TS2345,
    // naming `PromotedParam`), because everything below narrows to the derived arm. And
    // were it reached anyway, `pathOnRow` compares against `row.paramPath`, which a
    // promoted row does not have, so it would return null regardless. So this is the
    // narrowing spelled as a guard, and the property is guaranteed twice over rather than
    // resting here. Written down instead of left reading as though this line were the
    // thing standing between the agent and a wrong write.
    if (row.kind === 'promoted') continue;
    const path = pathOnRow(state, row, paramPath);
    if (path === null) continue;
    if (row.maskedBy?.[path]) continue;
    return { nodeId: row.nodeId, paramPath: path };
  }
  const ownerId = resolveDataParamOwner(state, id, paramRootOf(paramPath));
  return ownerId ? { nodeId: ownerId, paramPath } : null;
}

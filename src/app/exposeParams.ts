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
import { paramToSection, sectionsOf, type SectionId } from './inspectorSections';
import {
  controlOwnedRowKeys,
  makeSectionCtx,
  sectionRowFilter,
  type SectionCtx,
} from './inspectorSectionBody';
import { isDataLaneOperator, isPoserNode, resolveDataLaneBase, singleRef } from './operatorChain';
// The enumeration lives in `operatorStack` (it needs `nodeDisplayName`); the WALK
// vocabulary lives in the leaf. Importing each from where it actually is keeps the leaf a
// leaf — `operatorStack` reaches `sceneTreeWalk`, which closes a cycle back to the
// ownership reach, which is why the split exists at all (#516).
import { enumerateOperatorStack } from './operatorStack';

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
}

/** P7 adds a `'promoted'` arm (a spare param plus N drivers). The union is declared as a
 *  union from the start so 1:N is not retrofitted onto a struct with optional fields. */
export type ExposedParam = DerivedParam;

/**
 * Rows regrouped the way a panel draws them: per section, plus the unrouted bucket.
 *
 * Lives here rather than in the panel because BOTH inspector blocks need it and a second
 * spelling is a second answer. Order within each bucket is the projection's own order,
 * which is the panel's order — see the ORDER note in the header.
 */
export function groupExposedRows(rows: readonly ExposedParam[]): {
  bySection: ReadonlyMap<SectionId, string[]>;
  unrouted: string[];
} {
  const bySection = new Map<SectionId, string[]>();
  const unrouted: string[] = [];
  for (const r of rows) {
    if (r.home.section === null) {
      unrouted.push(r.paramPath);
      continue;
    }
    const list = bySection.get(r.home.section);
    if (list) list.push(r.paramPath);
    else bySection.set(r.home.section, [r.paramPath]);
  }
  return { bySection, unrouted };
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
    const section = paramToSection(key, declared);
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
  for (const plan of plans) {
    out.push(...rowsForNode(state, plan, selected.id, canApply));
    // …then whatever is wired INTO that node, one hop, at the same layer.
    for (const { node: producer, socket } of linkedProducers(state, plan.node)) {
      out.push(
        ...rowsForNode(
          state,
          {
            node: producer,
            role: 'linked',
            origin: 'linked',
            slot: `${plan.slot}.${socket}`,
            depth: plan.depth,
          },
          selected.id,
          canApply,
        ),
      );
    }
  }
  return out;
}

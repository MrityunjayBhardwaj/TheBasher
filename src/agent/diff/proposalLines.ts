// proposalLines — a pending proposal, op by op, as the chat lists it and the editors mark it (#1706).
//
// The user's call (2026-10-20 design review, board 10): an agent proposal lands where it takes
// effect. The chat lists one line per op (`Cube › position · 0, 0, 0 → 2, 0, 0`), each with a
// checkbox bound to the diff's own `selected[]`; and every editor the op touches marks it until the
// proposal is accepted or rejected. This module is the one pure answer both read: what each op says,
// what it was before, what it would be, where clicking it should take you, and which editors mark it.
//
// Labels for structural ops come from `describeChange` (#1612), the same function that names the
// undo step, so a line never names a change differently from the step it lands as. A value edit is
// named `Name › param`, because the value IS the change there.
//
// Two registries, keyed by op kind, are the contract a test derives from `OpSchema`: every kind has
// a line renderer (LINE_RENDERERS) and at least one editor mark (MARKS_BY_KIND), so a new op kind
// cannot be proposed and show nothing.
//
// Pure: reads the diff's original and forked states only; never the live store, never a write.
//
// REF: src/agent/diff/store.ts (PendingDiff); src/agent/describeChange.ts; #1706.

import type { DagState } from '../../core/dag/state';
import type { NodeId, Op } from '../../core/dag/types';
import { relationsOf } from '../../core/dag/idRefSweep';
import { nodeDisplayName } from '../../app/sceneTreeWalk';
import { describeChange } from '../describeChange';

/**
 * The editors that draw a mark for a pending proposal. The drawer tabs keep their ids
 * (`TimelineTab`): a mark on one of them is also counted on its tab.
 */
export const MARK_EDITORS = [
  'viewport',
  'inspector',
  'nodes',
  'dopesheet',
  'curve',
  'nla',
  'shots',
] as const;
export type MarkEditor = (typeof MARK_EDITORS)[number];

/** The drawer tabs among the mark editors. */
export const DRAWER_MARK_TABS = ['dopesheet', 'curve', 'nla', 'nodes', 'shots'] as const;
export type DrawerMarkTab = (typeof DRAWER_MARK_TABS)[number];

export interface ProposalTarget {
  /** Where clicking the line takes you. */
  editor: MarkEditor;
  /** The node to select there (null when the op has no one node, e.g. clearing an output). */
  nodeId: NodeId | null;
  param?: string;
}

export interface ProposalLine {
  /** Index into the diff's `ops` (and `selected`). */
  opIndex: number;
  kind: Op['type'];
  label: string;
  /** The value before, formatted; absent when the op has no prior value (an add). */
  before?: string;
  /** The value after, formatted; absent when there is no value to show. */
  after?: string;
  target: ProposalTarget;
  /** Every editor that marks this op. Never empty (the gate test holds it). */
  marks: readonly MarkEditor[];
}

/** What a proposal needs for its lines: the scene it was proposed on, the result, the ops. */
export interface ProposalSource {
  originalState: DagState;
  forkState: DagState;
  ops: readonly Op[];
}

// ── node families: which editor a node lives in ──────────────────────────────────────────────

const NLA_TYPES = new Set(['Track', 'Strip', 'Action']);

function isChannelType(type: string | undefined): boolean {
  return typeof type === 'string' && type.startsWith('KeyframeChannel');
}

function typeOf(src: ProposalSource, id: NodeId): string | undefined {
  return src.forkState.nodes[id]?.type ?? src.originalState.nodes[id]?.type;
}

/** The editors a node's own edits are marked in, and the one a click on its line opens. */
function homeOf(src: ProposalSource, id: NodeId): { editor: MarkEditor; marks: MarkEditor[] } {
  const type = typeOf(src, id);
  if (isChannelType(type)) return { editor: 'curve', marks: ['curve', 'dopesheet', 'nodes'] };
  if (type && NLA_TYPES.has(type)) return { editor: 'nla', marks: ['nla', 'nodes'] };
  if (type === 'Cut') return { editor: 'shots', marks: ['shots', 'nodes'] };
  return { editor: 'inspector', marks: ['inspector', 'viewport', 'nodes'] };
}

/**
 * The kinds' marks, as a registry the gate test reads. A kind's lines may add editors from the
 * node they touch (a channel edit is also marked in Curves and the Dopesheet) but never fewer.
 */
export const MARKS_BY_KIND: { readonly [K in Op['type']]: readonly MarkEditor[] } = {
  addNode: ['nodes', 'viewport'],
  removeNode: ['nodes', 'viewport'],
  connect: ['nodes'],
  disconnect: ['nodes'],
  setParam: ['inspector', 'nodes'],
  setMeta: ['nodes'],
  setSpareParam: ['inspector', 'nodes'],
  removeSpareParam: ['inspector', 'nodes'],
  // No editor shows an output binding but the node view (its SCENE / RENDER flags): the chat line
  // is its mark, and the node it binds is outlined in Nodes.
  setOutput: ['nodes'],
};

// ── values ───────────────────────────────────────────────────────────────────────────────────

function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/** A value as one short line: numbers trimmed, vectors comma-joined, objects summarised. */
export function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'none';
  if (typeof v === 'number') return num(v);
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 23)}…` : v;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'number')) return (v as number[]).map(num).join(', ');
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  return '{…}';
}

/** The value at a dotted param path (`material.base.color`). */
export function paramAt(params: unknown, path: string): unknown {
  let cur: unknown = params;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ── line renderers, one per op kind ──────────────────────────────────────────────────────────

type LineBody = Omit<ProposalLine, 'opIndex' | 'kind'>;
type Renderer<K extends Op['type']> = (
  op: Extract<Op, { type: K }>,
  src: ProposalSource,
) => LineBody;

const nameIn = (src: ProposalSource, id: NodeId): string =>
  src.originalState.nodes[id]
    ? nodeDisplayName(src.originalState.nodes, id)
    : nodeDisplayName(src.forkState.nodes, id);

/** The name a person sees for an edit: a data half's edit is named on its Object, as describeChange
 *  and the outliner name it (a write to a cube's BoxData is a change to the cube). */
const editedName = (src: ProposalSource, id: NodeId): string => {
  const owner = ownerObjects(src.originalState, id)[0] ?? ownerObjects(src.forkState, id)[0];
  return nameIn(src, owner ?? id);
};

/** describeChange's sentence for one op, or a fallback when it names nothing. */
function said(src: ProposalSource, op: Op, fallback: string): string {
  return describeChange(src.originalState, [op]) || fallback;
}

function union(a: readonly MarkEditor[], b: readonly MarkEditor[]): MarkEditor[] {
  return [...new Set([...a, ...b])];
}

export const LINE_RENDERERS: { readonly [K in Op['type']]: Renderer<K> } = {
  addNode: (op, src) => {
    const home = homeOf(src, op.nodeId);
    const timed = home.editor === 'inspector' ? [] : home.marks;
    return {
      label: said(src, op, `Added ${nameIn(src, op.nodeId)}`),
      target: { editor: timed.length ? home.editor : 'nodes', nodeId: op.nodeId },
      marks: union(MARKS_BY_KIND.addNode, timed),
    };
  },
  removeNode: (op, src) => ({
    label: said(src, op, `Removed ${nameIn(src, op.nodeId)}`),
    target: { editor: 'nodes', nodeId: op.nodeId },
    marks: MARKS_BY_KIND.removeNode,
  }),
  connect: (op, src) => ({
    label: `Connect ${nameIn(src, op.from.node)} → ${nameIn(src, op.to.node)} › ${op.to.socket}`,
    target: { editor: 'nodes', nodeId: op.to.node },
    marks: MARKS_BY_KIND.connect,
  }),
  disconnect: (op, src) => ({
    label: `Disconnect ${nameIn(src, op.from.node)} → ${nameIn(src, op.to.node)} › ${op.to.socket}`,
    target: { editor: 'nodes', nodeId: op.to.node },
    marks: MARKS_BY_KIND.disconnect,
  }),
  setParam: (op, src) => {
    const home = homeOf(src, op.nodeId);
    const prior = src.originalState.nodes[op.nodeId];
    return {
      label: `${editedName(src, op.nodeId)} › ${op.paramPath}`,
      before: prior ? formatValue(paramAt(prior.params, op.paramPath)) : undefined,
      after: formatValue(op.value),
      target: { editor: home.editor, nodeId: op.nodeId, param: op.paramPath },
      marks: union(MARKS_BY_KIND.setParam, home.marks),
    };
  },
  setMeta: (op, src) => {
    const prior = src.originalState.nodes[op.nodeId];
    if (op.position !== undefined) {
      return {
        label: said(src, op, `Moved ${nameIn(src, op.nodeId)} in the graph`),
        before: formatValue(prior?.meta?.position ?? null),
        after: formatValue(op.position),
        target: { editor: 'nodes', nodeId: op.nodeId },
        marks: MARKS_BY_KIND.setMeta,
      };
    }
    return {
      label: `${nameIn(src, op.nodeId)} › name`,
      before: prior ? formatValue(prior.meta?.name ?? prior.id) : undefined,
      after: formatValue(op.name ?? op.nodeId),
      target: { editor: 'inspector', nodeId: op.nodeId },
      marks: union(MARKS_BY_KIND.setMeta, ['inspector']),
    };
  },
  setSpareParam: (op, src) => {
    const prior = src.originalState.nodes[op.nodeId]?.spare?.[op.key];
    return {
      label: `${editedName(src, op.nodeId)} › ${op.key}`,
      before: prior ? formatValue(prior.value) : undefined,
      after: formatValue(op.param.value),
      target: { editor: 'inspector', nodeId: op.nodeId, param: op.key },
      marks: MARKS_BY_KIND.setSpareParam,
    };
  },
  removeSpareParam: (op, src) => {
    const prior = src.originalState.nodes[op.nodeId]?.spare?.[op.key];
    return {
      label: `${editedName(src, op.nodeId)} › remove ${op.key}`,
      before: prior ? formatValue(prior.value) : undefined,
      target: { editor: 'inspector', nodeId: op.nodeId, param: op.key },
      marks: MARKS_BY_KIND.removeSpareParam,
    };
  },
  setOutput: (op, src) => {
    const prior = src.originalState.outputs[op.name];
    return {
      label: said(src, op, `Set the ${op.name} output`),
      before: prior ? nameIn(src, prior.node) : 'none',
      after: op.ref ? nameIn(src, op.ref.node) : 'none',
      target: { editor: 'nodes', nodeId: op.ref?.node ?? prior?.node ?? null },
      marks: MARKS_BY_KIND.setOutput,
    };
  },
};

function renderLine(op: Op, src: ProposalSource): LineBody {
  // The registry is typed per kind; this is the one place the union meets it.
  return (LINE_RENDERERS[op.type] as Renderer<Op['type']>)(op as never, src);
}

const linesCache = new WeakMap<ProposalSource, ProposalLine[]>();

/** One line per op, in the diff's order. */
export function proposalLines(src: ProposalSource): ProposalLine[] {
  const hit = linesCache.get(src);
  if (hit) return hit;
  const lines = src.ops.map((op, opIndex) => ({ opIndex, kind: op.type, ...renderLine(op, src) }));
  linesCache.set(src, lines);
  return lines;
}

// ── what the editors read ────────────────────────────────────────────────────────────────────

/** Every node an op touches (both ends of an edge). */
function touched(op: Op): NodeId[] {
  switch (op.type) {
    case 'connect':
    case 'disconnect':
      return [op.from.node, op.to.node];
    case 'setOutput':
      return op.ref ? [op.ref.node] : [];
    default:
      return [op.nodeId];
  }
}

/** The Object a data half belongs to (a write to a cube's BoxData is a change to the cube). */
function ownerObjects(state: DagState, id: NodeId): NodeId[] {
  if (!state.nodes[id]) return [];
  return relationsOf(state, id)
    .wiresOut.filter((w) => w.socket === 'data' && state.nodes[w.node]?.type === 'Object')
    .map((w) => w.node);
}

/** The Object a person sees for a node: its owner when it is a data half, else itself. */
export function objectOf(state: DagState, id: NodeId): NodeId {
  return ownerObjects(state, id)[0] ?? id;
}

/**
 * The nodes a proposal marks in one editor. `selectedOnly` keeps only the ops still ticked, so an
 * unticked line's mark goes away with it. The viewport set also holds each touched data half's
 * Object, because the viewport draws Objects.
 */
export function proposedNodeIds(
  src: ProposalSource & { selected?: readonly boolean[] },
  editor: MarkEditor,
): Set<NodeId> {
  const out = new Set<NodeId>();
  const lines = proposalLines(src);
  src.ops.forEach((op, i) => {
    if (src.selected && !src.selected[i]) return;
    if (!lines[i].marks.includes(editor)) return;
    for (const id of touched(op)) {
      out.add(id);
      if (editor === 'viewport') {
        for (const o of ownerObjects(src.forkState, id)) out.add(o);
        for (const o of ownerObjects(src.originalState, id)) out.add(o);
      }
    }
  });
  return out;
}

/** How many lines each drawer tab marks (tabs with none are absent). */
export function proposalTabCounts(
  src: ProposalSource & { selected?: readonly boolean[] },
): Partial<Record<DrawerMarkTab, number>> {
  const counts: Partial<Record<DrawerMarkTab, number>> = {};
  proposalLines(src).forEach((line, i) => {
    if (src.selected && !src.selected[i]) return;
    for (const tab of DRAWER_MARK_TABS) {
      if (line.marks.includes(tab)) counts[tab] = (counts[tab] ?? 0) + 1;
    }
  });
  return counts;
}

/**
 * A node's (or one of its params') value before and after the proposal, or null when the
 * proposal does not touch it. Without `param`, before/after are the whole node (null where it does
 * not exist: an added node has no before, a removed one no after).
 */
export function proposedChange(
  src: ProposalSource & { selected?: readonly boolean[] },
  nodeId: NodeId,
  param?: string,
): { before: unknown; after: unknown } | null {
  const hit = src.ops.some((op, i) => {
    if (src.selected && !src.selected[i]) return false;
    if (param === undefined) return touched(op).includes(nodeId);
    if (op.type === 'setParam')
      return (
        op.nodeId === nodeId &&
        (op.paramPath === param ||
          op.paramPath.startsWith(`${param}.`) ||
          param.startsWith(`${op.paramPath}.`))
      );
    if (op.type === 'setSpareParam' || op.type === 'removeSpareParam')
      return op.nodeId === nodeId && op.key === param;
    return false;
  });
  if (!hit) return null;
  const before = src.originalState.nodes[nodeId] ?? null;
  const after = src.forkState.nodes[nodeId] ?? null;
  if (param === undefined) return { before, after };
  const read = (n: typeof before) =>
    n ? (paramAt(n.params, param) ?? n.spare?.[param]?.value) : undefined;
  return { before: read(before), after: read(after) };
}

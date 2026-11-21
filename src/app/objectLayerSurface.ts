// objectLayerSurface — the pure, read-only "what changes this object" surface (#1940, #1894 S4).
//
// One call, `objectLayerSurface(state, nodeId, ctx?, cache?) → ObjectSurface`, answers: for the
// object `nodeId` resolves to, which STRUCTURAL lanes layer onto it, each lane's rows, read ==
// render. It is the cross-lane projection that sits ABOVE the per-lane row builder (`layerView`)
// and below the panel (T2). It owns no value logic and no second resolver — every row's displayed
// value is `layerView`'s, which folds through `resolveEvaluatedParam` (the render's own read).
//
// Two disciplines hold it, both inherited from `layerView` (#1894 S1):
//
//   G3 — PURE VIEW. Which group a row lands in comes from its LANE (`rowLaneOfType`, a contract
//   field — a chain declarer's spine type, or a `mainInput` node's carried type), NEVER from a node
//   KIND. There is no `nodeType === 'PoseLayer'`, no `worldStep` read, no `switch` on a registered
//   type. The lane→group table below is the only dispatch, and it dispatches on the lane. A source
//   gate proves the module names no registered node kind.
//
//   read == render. Each row is built by `layerView`, which reads an animatable amount (a step's
//   influence, a pose layer's weight) as the FOLDED value the renderer composes, not the raw param
//   the graph stores. The warm evaluator cache is forwarded straight through so a per-scrub re-read
//   stays warm (#1389); omitted, it is a cold walk, exactly as `layerView` is alone.
//
// MEASURED (do not re-derive): one `stackOf` walk on the object's `out` socket reaches ALL three
// structural lanes. An `Object` declares `mainInput: null` with `data` (modifiers), `constraints`
// and `pose` as separate group inputs (`ObjectNode.ts`), so the stack descends each as a nested
// group in one walk — no per-lane output ref is needed. The base data node, the object itself and
// the constraint carriers read `rowLaneOfType === null` and drop out; the influence-value internals
// read the `Number` lane and are not structural, so they drop out too.
//
// SEAM FOR T0b (#1940): the VALUE lanes (channel / strip / driver) are NOT nodes in this walk —
// they are folds inside `resolveEvaluatedParam`, enumerated by their own adapters. When T0b lands,
// its value group PREPENDS the structural groups here (value lanes set each param; modifiers,
// constraints and pose consume those params downstream). The structural order below is the tail of
// that pipeline; T0b adds the head. No value-lane code lives here yet.
//
// REF: issue #1940 (plan scratchpad/stage3-PLAN.md, slice T0a); #1894 S4; src/app/layerView.ts;
//      src/app/stackTree.ts (`stackOf`); src/app/operatorStack.ts (`resolveStackObject`);
//      src/app/operatorChain.ts (`rowLaneOfType`).

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, SocketTypeName } from '../core/dag/types';
import { layerView, type RowView } from './layerView';
import { rowLaneOfType } from './operatorChain';
import { resolveStackObject } from './operatorStack';
import { stackOf, type StackNodeRow, type StackRow } from './stackTree';

/** One lane's worth of rows, with the group label and its count. */
export interface LaneGroup {
  /** The pipeline group this lane is: `modifier`, `constraint` or `pose`. */
  readonly lane: string;
  readonly rows: readonly RowView[];
  readonly count: number;
}

/** The grouped read-only surface for one object: its structural lanes, in pipeline order. */
export interface ObjectSurface {
  readonly groups: readonly LaneGroup[];
}

/**
 * The structural lanes a layer stands on, in FIXED pipeline order: modifiers (geometry) →
 * constraints (world transform) → pose (skeleton). A lane is a SOCKET TYPE (the type flowing
 * through a chain spine or a `mainInput` node), read off the contract by `rowLaneOfType`; the group
 * is the pipeline name a person reads. This table is the ONLY dispatch — it is a lane table, not a
 * kind switch (G3). `ObjectData` is the modifier lane, `Matrix4` the constraint lane, `PosedSkeleton`
 * the pose lane (all three are `LAYER_LANES` keys). The VALUE lanes prepend this list in T0b.
 */
const STRUCTURAL_LANES: readonly { readonly lane: SocketTypeName; readonly group: string }[] = [
  { lane: 'ObjectData', group: 'modifier' },
  { lane: 'Matrix4', group: 'constraint' },
  { lane: 'PosedSkeleton', group: 'pose' },
];

/** Every node row the stack draws, each unique node once: a `same` row points at a full row that is
 *  already in the list, so it is skipped rather than double-counted. */
function flattenNodeRows(rows: readonly StackRow[]): StackNodeRow[] {
  return rows.flatMap((row) =>
    row.kind === 'same'
      ? []
      : [
          row,
          ...row.groups.flatMap((group) => flattenNodeRows(group.rows)),
          ...flattenNodeRows(row.template?.inside ?? []),
        ],
  );
}

/**
 * The grouped read-only surface for the object `nodeId` resolves to. `nodeId` may be the object or
 * any node in one of its stacks: `resolveStackObject` walks a modifier forward to its object, and
 * falls back to `nodeId` itself when it is already the object (or wears no stack). `ctx` is the
 * playhead the folded values are read at; `cache` is the warm UI evaluator cache, forwarded through
 * to `layerView` unchanged (#1389) — omitted, every read is a cold walk, as `layerView` is alone.
 */
export function objectLayerSurface(
  state: DagState,
  nodeId: string,
  ctx?: EvalCtx,
  cache?: EvaluatorCache,
): ObjectSurface {
  const objectId = resolveStackObject(state, nodeId) ?? nodeId;
  const rows = flattenNodeRows(stackOf(state, { node: objectId, socket: 'out' }));

  // One group per structural lane the object stands on, in the fixed pipeline order. A lane with no
  // rows is omitted (no empty group). The VALUE group prepends this loop in T0b.
  const groups: LaneGroup[] = [];
  for (const { lane, group } of STRUCTURAL_LANES) {
    const laneRows = rows
      .filter((row) => rowLaneOfType(row.nodeType) === lane)
      .map((row) => layerView(state, row, ctx, cache));
    if (laneRows.length > 0) {
      groups.push({ lane: group, rows: laneRows, count: laneRows.length });
    }
  }
  return { groups };
}

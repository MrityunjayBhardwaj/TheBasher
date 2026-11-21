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
// THE VALUE LANES (T0b, #1940): channel / strip / driver are NOT nodes in the `stackOf` walk —
// they are folds inside `resolveEvaluatedParam` (`:98-156`, base → channels → strips → drivers →
// mute, render-identical), each enumerated by its OWN function off the object id, not by walking
// edges. So they need a per-lane ADAPTER rather than `layerView`: `channelEntriesFromNodes`,
// `stripChannelValuesForTarget` and `driverBandsForTarget` each yield that lane's contributors, and
// the adapter maps each to the SAME `RowView` the structural lanes use. A value row's displayed
// amount is the FOLDED param value — `resolveEvaluatedParam(state, objectId, paramPath, ctx, cache)`,
// the render's own read — so read == render holds through each lane's native read, not one call.
//
// They PREPEND the structural groups, in the fold order channels → strips → drivers (the order
// `resolveEvaluatedParam` composes them, `:101-152`): value lanes SET each param; modifiers,
// constraints and pose CONSUME those params downstream. The structural order below is the tail of
// that pipeline; the value lanes are the head.
//
// #1928 BOUNDARY (T1): a value row's RENDER road may apply only the BASE value, not the folded one.
// Each row carries `rendersBaseOnly` — material params (`material.*`) are flagged true, so a surface
// presents them with that caveat and never as a plain row (the one silent read≠render class this arc
// kills). glTF-child TRS is a NAMED, deferred gap (no cheap imported-child predicate — see
// `rendersBaseOnly`). Flips to all-false when #1928 wires those render roads to fold.
//
// read == render, cache-forwarded: the value adapters call `resolveEvaluatedParam` with the SAME
// forwarded cache (`cache`), opening no cold eval origin of their own (#1386) — the surface stays a
// FORWARDER, as it is for the structural lanes through `layerView`.
//
// REF: issue #1940 (plan scratchpad/stage3-PLAN.md, slices T0a/T0b); #1894 S4; #1928 (honesty);
//      src/app/layerView.ts; src/app/stackTree.ts (`stackOf`); src/app/operatorStack.ts
//      (`resolveStackObject`); src/app/operatorChain.ts (`rowLaneOfType`);
//      src/app/resolveEvaluatedParam.ts (the value fold); src/app/driverStack.ts
//      (`driverBandsForTarget`); src/app/layeredChannels.ts (`stripChannelValuesForTarget`);
//      src/app/nodeChannels.ts (`channelEntriesFromNodes` / `directChannelNodesForTarget`).

import type { EvaluatorCache } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import type { EvalCtx, SocketTypeName } from '../core/dag/types';
import { driverBandsForTarget } from './driverStack';
import { formatValue, layerView, type RowView } from './layerView';
import { stripChannelValuesForTarget } from './layeredChannels';
import { channelEntriesFromNodes, directChannelNodesForTarget } from './nodeChannels';
import { rowLaneOfType } from './operatorChain';
import { resolveStackObject } from './operatorStack';
import { resolveEvaluatedParam } from './resolveEvaluatedParam';
import { stackOf, type StackNodeRow, type StackRow } from './stackTree';
import { stripTargetsOf } from './stripTargetIndex';

/**
 * A surface row: a `RowView` plus whether this lane's RENDER road applies only the BASE value, not
 * the folded one (#1928). `true` ⇒ the row reads right but renders base-only today, so a surface
 * MUST present it with that caveat, never as a plain row — the one silent read≠render class this
 * whole arc exists to kill. Structural rows (modifier/constraint/pose) render folded, so they are
 * always `false`; only value-lane rows on a render-incomplete param carry `true`.
 */
export type SurfaceRow = RowView & {
  readonly rendersBaseOnly: boolean;
  /** The node the row stands for — the modifier/constraint/pose/driver/channel node — so a surface
   *  can route a click to it. Null when the contributor is synthetic (a strip has no own node). */
  readonly nodeId: string | null;
};

/** One lane's worth of rows, with the group label and its count. */
export interface LaneGroup {
  /**
   * The pipeline group this lane is. Value lanes (what SETS each param) come first:
   * `channel`, `strip`, `driver`. Structural lanes (what CONSUMES them) follow:
   * `modifier`, `constraint`, `pose`.
   */
  readonly lane: string;
  readonly rows: readonly SurfaceRow[];
  readonly count: number;
}

/** The grouped read-only surface for one object: its value + structural lanes, in pipeline order. */
export interface ObjectSurface {
  /** The Object `nodeId` resolved to — what a row pick reports as its `objectId`. */
  readonly objectId: string;
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

/** The playhead a value row is read at when the caller gives none: scene time zero, as `layerView`
 *  defaults to. `resolveEvaluatedParam` needs a ctx; this supplies it for the pure, cache-less read. */
const STATIC_CTX: EvalCtx = { time: { frame: 0, seconds: 0, normalized: 0 } };

/**
 * Whether the RENDER road for `paramPath` applies only the BASE value, not the folded one (#1928).
 * Two param kinds fold on the READ side yet are not applied on the render side today:
 *   - material params (`material.*`) — the applied material (`resolveMeshMaterial`) reads the base;
 *   - glTF-child transforms — DEFERRED, ON PURPOSE. There is no cheap runtime predicate for "this
 *     node is an imported glTF child", and a loose detector would MISLABEL honest rows (worse than a
 *     named gap). So this covers only the material case; a glTF-child TRS row is a KNOWN, documented
 *     gap until a child detector lands, guarded by a test that reds the day it becomes detectable
 *     (V208 — a decision you cannot take yet is a test that reds when it becomes takeable).
 * Flips to all-false when #1928 wires these render roads to fold.
 */
function rendersBaseOnly(paramPath: string): boolean {
  return paramPath.startsWith('material.');
}

/** One uniform value-lane row: its contributor's label, the lane word, the folded param value read
 *  == render, the contributor's mute, and whether its render road is base-only (#1928). `tag` carries
 *  the param path the lane writes; a value row is not a structural stack node, so it exposes/overrides
 *  nothing and holds no pose vocabulary. */
function valueRow(
  lane: string,
  name: string,
  paramPath: string,
  muted: boolean,
  influence: string | null,
  nodeId: string | null,
): SurfaceRow {
  return {
    name,
    type: lane,
    tag: paramPath,
    overridden: [],
    exposed: [],
    influence,
    muted,
    pose: null,
    rendersBaseOnly: rendersBaseOnly(paramPath),
    nodeId,
  };
}

/**
 * The VALUE lanes layering onto `objectId`, as uniform `RowView` groups in the fold order
 * channels → strips → drivers. Each lane enumerates its OWN contributors off the object id (not an
 * edge walk), and every row's `influence` is the FOLDED param value — `resolveEvaluatedParam` with
 * the forwarded `cache`, the render's own read (read == render). A lane with no contributor yields
 * no group (no empty group). No kind is named: the three enumerators are the dispatch (G3).
 */
function valueLaneGroups(
  state: DagState,
  objectId: string,
  ctx: EvalCtx,
  cache?: EvaluatorCache,
): LaneGroup[] {
  // The render-identical read for one param of this object, folded through the SAME resolver the
  // renderer uses, with the cache forwarded (no cold origin, #1386). null ⇒ nothing overrides ⇒
  // the row shows no amount (the caller's base), as `layerView` does for an un-overridden influence.
  const folded = (paramPath: string): string | null => {
    const resolved = resolveEvaluatedParam(state, objectId, paramPath, ctx, cache);
    return resolved ? formatValue(resolved.value) : null;
  };

  // channel — every KEYED KeyframeChannel targeting the object, normalized to its declared value
  // (name, param path and mute read off `KeyframeChannelValue`, never an inline cast of raw params),
  // one row per channel. A channel with no keyframes contributes nothing, so it is no contributor.
  // Symmetric with the strip path below — both read the normalized value the fold consumes.
  const channelRows = channelEntriesFromNodes(
    directChannelNodesForTarget(state.nodes, objectId),
  ).map(({ node, value: v }) =>
    valueRow('channel', v.name, v.paramPath, v.mute === true, folded(v.paramPath), node.id),
  );

  // strip — the synthetic channels a placed Strip emits (one per strip·param), the SAME enumerator
  // the fold consumes; asked only of a node some strip targets (`stripTargetsOf`), else skipped. The
  // value is synthetic (no own node), so a strip row carries `nodeId: null` — the surface routes it
  // by lane, not by node.
  const stripRows = stripTargetsOf(state.nodes).has(objectId)
    ? stripChannelValuesForTarget(state.nodes, objectId).map((v) =>
        valueRow('strip', v.name, v.paramPath, v.mute === true, folded(v.paramPath), null),
      )
    : [];

  // driver — every driven param BAND, one row per contributor (its driver source name + its own
  // node), the SAME bottom → top order `DriverStackControls` renders.
  const driverRows = driverBandsForTarget(state, objectId).flatMap((band) =>
    band.entries.map((e) =>
      valueRow('driver', e.label, band.paramPath, e.muted, folded(band.paramPath), e.nodeId),
    ),
  );

  const groups: LaneGroup[] = [];
  for (const [lane, rows] of [
    ['channel', channelRows],
    ['strip', stripRows],
    ['driver', driverRows],
  ] as const) {
    if (rows.length > 0) groups.push({ lane, rows, count: rows.length });
  }
  return groups;
}

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

  // The VALUE lanes (what SETS each param) come FIRST, in fold order channels → strips → drivers;
  // the structural lanes (what CONSUMES them) follow. Each value row's amount is folded through the
  // forwarded cache, so it is read == render and opens no cold origin.
  const groups: LaneGroup[] = [...valueLaneGroups(state, objectId, ctx ?? STATIC_CTX, cache)];

  // One group per structural lane the object stands on, in the fixed pipeline order. A lane with no
  // rows is omitted (no empty group).
  for (const { lane, group } of STRUCTURAL_LANES) {
    const laneRows: SurfaceRow[] = rows
      .filter((row) => rowLaneOfType(row.nodeType) === lane)
      // Structural lanes render the FOLDED value (modifiers/constraints/pose all apply), so never
      // base-only (#1928 is a value-lane concern). `rendersBaseOnly: false`, not a guess. The row
      // carries its own node id (the stack node) so a surface can route a click to it.
      .map((row) => ({
        ...layerView(state, row, ctx, cache),
        rendersBaseOnly: false,
        nodeId: row.nodeId,
      }));
    if (laneRows.length > 0) {
      groups.push({ lane: group, rows: laneRows, count: laneRows.length });
    }
  }
  return { objectId, groups };
}

// driverStack — the AUTHORING half of the DRIVER (relational-CHOP → param) stack
// (#316). The third member of the family, and the contrast across the three files is
// the whole taxonomy:
//
//   operatorStack  (SOP)        : a wired sub-chain. add/move/remove = RE-WIRING.
//   constraintStack(CHOP → pose): an edge-LESS set on one `target`, ordered by an
//                                 `order` field. add/move/remove = FIELD WRITES.
//   driverStack    (CHOP → param): the same edge-less set, but keyed one level finer —
//                                 by (`target`, `paramPath`). An object has ONE constraint
//                                 stack and MANY driver stacks: one per driven param BAND.
//
// THE BAND is the unit. Two drivers only contend when they write the SAME param, because
// the fold groups by paramPath (overlayChannels). So ordering, muting and reordering are
// all per-band — a driver on `intensity` and one on `position` never compete, and the
// panel renders them as separate stacks rather than one misleading list.
//
// Enumeration is NOT duplicated here: it comes from `driverStackForTarget` (paramDrivers.ts)
// — the SAME scan + sort the fold consumes — asked for its muted members too. If the panel
// enumerated separately it could drift from the resolver and the rows would stop matching
// what actually renders (the [[V99]] rule; the same reason constraintStack defers).
//
// There is deliberately NO "+ Add" builder here. A driver is only meaningful once it has a
// SOURCE (an unbound one would fold a constant 0 straight onto the param and visibly break
// it), and choosing a source is what `ParamDriverBind` does on the param row — where the
// param, and therefore the band, is already known. The panel MANAGES the stack; the param
// row CREATES it. That is not a gap: it is where the affordance belongs.
//
// Every mutation is a pure Op[] (dispatchAtomic at the call site → save/undo/animate for
// free, V1), mirroring operatorStack/constraintStack.
//
// REF: src/app/paramDrivers.ts (the shared enumeration + the fold it feeds);
//      src/app/DriverStackControls.tsx (the panel); src/app/constraintStack.ts (the pose
//      twin); src/app/ParamDriverBind.tsx (the source picker = the create road).

import type { DagState } from '../core/dag/state';
import type { Node, Op } from '../core/dag/types';
import { driverStackForTarget, isDriverMuted } from './paramDrivers';
import type { StackRowEntry } from './OperatorStackRows';
import { nodeDisplayName } from './sceneTreeWalk';
import { transformSourceOf, transformVecSourceOf } from './transformChannelSource';

/** One driven param of an object: the band, and the ordered stack writing it. */
export interface DriverBand {
  readonly paramPath: string;
  /** Bottom → top, muted included — the SAME order the fold applies. */
  readonly entries: StackRowEntry[];
}

function nameOf(state: DagState, nodeId: string | undefined): string {
  const n = nodeId ? state.nodes[nodeId] : undefined;
  return n ? nodeDisplayName(n) : '?';
}

/**
 * What a driver row SAYS. Not the driver's own node name — every ParamDriver is called
 * "ParamDriver", so a band with two of them would render two identical rows and the panel
 * would be useless. A driver is identified by its SOURCE, so name that: the controller
 * channel it reads, the spare it pulls, or the compute node wired into it.
 */
export function driverSourceLabel(state: DagState, driver: Node): string {
  const p = (driver.params ?? {}) as {
    sourceSpare?: { node?: string; key?: string };
  };

  // The vec controller road (#300 F2b) — the whole position of a Point controller.
  const vec = transformVecSourceOf(driver);
  if (vec) return `${nameOf(state, vec.node)}.position`;

  // The scalar Transform-Channel road (#296) — one channel of a controller (Null).
  const xf = transformSourceOf(driver);
  if (xf) return `${nameOf(state, xf.node)}.${xf.channel}`;

  // The spare road (#294) — a promoted knob on another node (the Houdini `ch()` pull).
  const spare = p.sourceSpare;
  if (spare?.node && spare.key) return `${nameOf(state, spare.node)}.${spare.key}`;

  // The wired road (#293) — the compute node feeding `in` / `inVec` (a Lag, a Solver,
  // a SampleGeometry, a Math chain…). Its own name is the most useful thing to show.
  const binding = driver.inputs?.inVec ?? driver.inputs?.in;
  const ref = (Array.isArray(binding) ? binding[0] : binding) as { node?: string } | undefined;
  if (ref?.node) return nameOf(state, ref.node);

  return 'unbound';
}

/**
 * Every driven param BAND on `targetId`, each with its ordered stack (muted included, so a
 * bypassed row still renders and can be re-enabled). Bands are sorted by param path so the
 * panel's section order is stable across edits; the ROWS inside a band keep the fold's
 * bottom → top order, never a sort of their own.
 */
export function driverBandsForTarget(state: DagState, targetId: string): DriverBand[] {
  const drivers = driverStackForTarget(state.nodes, targetId, undefined, true);
  const byPath = new Map<string, Node[]>();
  for (const d of drivers) {
    const path = ((d.params ?? {}) as { paramPath?: string }).paramPath ?? '';
    const arr = byPath.get(path);
    if (arr) arr.push(d);
    else byPath.set(path, [d]);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([paramPath, members]) => ({
      paramPath,
      // `driverStackForTarget` already returned these bottom → top; grouping preserves it.
      entries: members.map((d) => ({
        nodeId: d.id,
        muted: isDriverMuted(d),
        label: driverSourceLabel(state, d),
      })),
    }));
}

/** Bypass / un-bypass a driver. (`mute` — same param name the constraint twin uses; the
 *  geometry modifier spells the same idea `muted`. The shared row component takes a
 *  normalized boolean, and each builder writes its own field.) */
export function buildToggleDriverMuteOp(state: DagState, driverId: string): Op | null {
  const node = state.nodes[driverId];
  if (!node || node.type !== 'ParamDriver') return null;
  return { type: 'setParam', nodeId: driverId, paramPath: 'mute', value: !isDriverMuted(node) };
}

/**
 * Move a driver one slot up (later) or down (earlier) WITHIN ITS BAND — a swap of the two
 * members' `order` values, the edge-less analogue of the geometry stack's re-wire. Written
 * as two setParams so it is one undo entry and the orders stay a clean permutation.
 *
 * Scoped to the band (target + paramPath) because that is the only place drivers contend:
 * swapping against a driver on a DIFFERENT param would reorder nothing the fold can see.
 */
export function buildMoveDriverOps(
  state: DagState,
  driverId: string,
  dir: 'up' | 'down',
): Op[] | null {
  const node = state.nodes[driverId];
  if (!node || node.type !== 'ParamDriver') return null;
  const p = (node.params ?? {}) as { target?: unknown; paramPath?: unknown };
  if (typeof p.target !== 'string' || !p.target) return null;
  if (typeof p.paramPath !== 'string' || !p.paramPath) return null;

  const band = driverStackForTarget(state.nodes, p.target, p.paramPath, true);
  const i = band.findIndex((d) => d.id === driverId);
  if (i < 0) return null;
  const j = dir === 'up' ? i + 1 : i - 1;
  if (j < 0 || j >= band.length) return null; // already at the end — the UI disables this

  const orderOf = (n: Node): number => {
    const o = ((n.params ?? {}) as { order?: unknown }).order;
    return typeof o === 'number' ? o : 0;
  };
  const a = band[i];
  const b = band[j];
  // Equal orders (any project authored before the bind sites assigned them) would make a
  // swap a no-op — assign the NEIGHBOUR'S INDEX-derived slot instead so the move is always
  // observable. Same guard the constraint twin uses.
  const aOrder = orderOf(a) === orderOf(b) ? j : orderOf(b);
  const bOrder = orderOf(a) === orderOf(b) ? i : orderOf(a);
  return [
    { type: 'setParam', nodeId: a.id, paramPath: 'order', value: aOrder },
    { type: 'setParam', nodeId: b.id, paramPath: 'order', value: bOrder },
  ];
}

/** Remove a driver. Edge-less on the target side → nothing to unwire there; the node goes.
 *  Its SOURCE (the compute node feeding `in`) is left alone on purpose: it may be shared
 *  with other drivers, and it is an ordinary graph node the user can delete themselves. */
export function buildRemoveDriverOps(state: DagState, driverId: string): Op[] | null {
  const node = state.nodes[driverId];
  if (!node || node.type !== 'ParamDriver') return null;
  return [{ type: 'removeNode', nodeId: driverId }];
}

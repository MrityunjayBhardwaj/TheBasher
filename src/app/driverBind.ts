// driverBind — the PURE op-builder for authoring / removing a ParamDriver binding
// (#293, Inc 2, decision D-2). The inspector "bind" affordance
// (`ParamDriverBind.tsx`) is a thin view over these; the logic lives here so it is
// unit-testable without React and without Date.now()/Math.random() (the caller
// supplies the fresh driver id).
//
// A bind creates the relation node on the V88 PULL rail: `addNode(ParamDriver{target,
// paramPath})` + `connect(source.out → driver.in)`. The connect op re-runs the wire
// cycle guard for free; this builder ADDITIONALLY runs the G6 driver-level guard
// (`wouldCreateCycle` with `driverParamDeps`) so the edge-less driver→target relation
// cannot close a loop the wire guard can't see (a driver whose compute graph
// transitively reads back its own target). Degenerate → rejected, never a NaN cook.
//
// REF: ref/GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS.md §7 (G1/G6, DR10); state.ts
//      wouldCreateCycle; src/app/paramDrivers.ts (driverParamDeps); issue #293.

import type { DagState } from '../core/dag/state';
import { wouldCreateCycle } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';
import { getNodeType } from '../core/dag/registry';
import { driverNodesForTarget, driverParamDeps } from './paramDrivers';

export interface DriverBindRequest {
  /** The node whose param is being driven. */
  targetId: string;
  /** The param path on the target (dotted; e.g. 'intensity', 'material.opacity'). */
  paramPath: string;
  /** The compute-graph output feeding the driver's `in` (a Number socket). */
  source: NodeRef;
  /** A fresh, unused node id for the driver (caller-generated → deterministic tests). */
  driverId: string;
}

export type DriverBindResult = { ok: true; ops: Op[] } | { ok: false; reason: string };

/**
 * The forward Op chain that binds `targetId.paramPath` to `source` through a new
 * ParamDriver, or a rejection when the bind would create a cycle (G6). `dispatchAtomic`
 * computes the inverses (removeNode + disconnect) for undo.
 */
export function buildBindDriverOps(state: DagState, req: DriverBindRequest): DriverBindResult {
  const { targetId, paramPath, source, driverId } = req;
  if (!targetId || !paramPath) return { ok: false, reason: 'missing target or param' };
  if (!source.node) return { ok: false, reason: 'no source selected' };
  // G6 — the driven target will depend on `source` through the driver. Reject if
  // `source` already (transitively, via wired edges + existing driver overlays) depends
  // on `target`, which would close the loop target ← driver ← source → … → target.
  if (wouldCreateCycle(state, source.node, targetId, 32, driverParamDeps(state.nodes))) {
    return { ok: false, reason: 'binding would create a driver cycle' };
  }
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: driverId,
      nodeType: 'ParamDriver',
      params: { target: targetId, paramPath, blendMode: 'replace', order: 0 },
    },
    {
      type: 'connect',
      from: source,
      to: { node: driverId, socket: 'in' },
    },
  ];
  return { ok: true, ops };
}

/** The forward Op to UNbind a target param: remove every ParamDriver bound to
 *  (targetId, paramPath). Usually one; robust to duplicates. Empty when none. */
export function buildUnbindDriverOps(state: DagState, targetId: string, paramPath: string): Op[] {
  return driverNodesForTarget(state.nodes, targetId)
    .filter((d) => (d.params as { paramPath?: unknown }).paramPath === paramPath)
    .map((d) => ({ type: 'removeNode', nodeId: d.id }));
}

export interface DriverSourceOption {
  ref: NodeRef;
  label: string;
}

/**
 * The pickable driver SOURCES: every node exposing a `Number` output socket, EXCEPT
 * the target itself (a param cannot be driven by its own node's output — the trivial
 * self-cycle) and existing ParamDrivers (introspection-only output). Labelled by
 * `meta.name ?? id` for the source picker. Sorted for a stable menu.
 */
export function driverSourceOptions(state: DagState, targetId: string): DriverSourceOption[] {
  const out: DriverSourceOption[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.id === targetId || node.type === 'ParamDriver') continue;
    const def = getNodeType(node.type);
    if (!def) continue;
    for (const [socket, desc] of Object.entries(def.outputs)) {
      if (desc.type !== 'Number') continue;
      const label = node.meta?.name?.trim() || node.id;
      out.push({ ref: { node: node.id, socket }, label: `${label} (${node.type})` });
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

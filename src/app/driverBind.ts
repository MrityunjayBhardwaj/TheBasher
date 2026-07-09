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
import { TRANSFORM_CHANNELS, type TransformChannel } from '../nodes/ParamDriver';

/**
 * A pickable driver source — the two roads of the pull rail (#294):
 *  - `output` — a wired compute-graph Number output (the Inc-2 road): the driver's
 *    `in` is connected to it.
 *  - `spare`  — a promoted numeric spare param on another node (the `ch()` road): the
 *    driver stores the ref in `sourceSpare` and reads it in the resolver seam, no wire.
 */
export type DriverSource =
  | { kind: 'output'; id: string; label: string; ref: NodeRef }
  | { kind: 'spare'; id: string; label: string; node: string; key: string }
  // #296 — a transform CHANNEL of a controller (a Null): the primary controller road
  // (Blender's Transform Channel driver / Houdini `ch("../null/tx")`). Optional `remap`
  // maps the channel through a range (the "map a transform to a range" model).
  | {
      kind: 'transform';
      id: string;
      label: string;
      node: string;
      channel: TransformChannel;
      remap?: { inMin: number; inMax: number; outMin: number; outMax: number };
    };

/** The source node id backing a DriverSource (for the cycle guard). */
function sourceNodeId(source: DriverSource): string {
  return source.kind === 'output' ? source.ref.node : source.node;
}

export interface DriverBindRequest {
  /** The node whose param is being driven. */
  targetId: string;
  /** The param path on the target (dotted; e.g. 'intensity', 'material.opacity'). */
  paramPath: string;
  /** The source feeding the driver — a wired Number output OR a promoted spare param. */
  source: DriverSource;
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
  const srcNode = sourceNodeId(source);
  if (!srcNode) return { ok: false, reason: 'no source selected' };
  // G6 — the driven target will depend on `source` through the driver. Reject if
  // `source` already (transitively, via wired edges + existing driver overlays, incl.
  // the spare road via driverParamDeps) depends on `target`, which would close the loop
  // target ← driver ← source → … → target.
  if (wouldCreateCycle(state, srcNode, targetId, 32, driverParamDeps(state.nodes))) {
    return { ok: false, reason: 'binding would create a driver cycle' };
  }
  if (source.kind === 'spare') {
    // The `ch()` road — one edge-less node carrying the spare ref; no `connect`. Its
    // value is resolved in the paramDrivers seam (readBaseParam), not through `in`.
    return {
      ok: true,
      ops: [
        {
          type: 'addNode',
          nodeId: driverId,
          nodeType: 'ParamDriver',
          params: {
            target: targetId,
            paramPath,
            blendMode: 'replace',
            order: 0,
            sourceSpare: { node: source.node, key: source.key },
          },
        },
      ],
    };
  }
  if (source.kind === 'transform') {
    // #296 — the Transform Channel road: one edge-less node carrying the
    // {node, channel, remap?}; resolved in the seam via resolveEvaluatedTransform.
    return {
      ok: true,
      ops: [
        {
          type: 'addNode',
          nodeId: driverId,
          nodeType: 'ParamDriver',
          params: {
            target: targetId,
            paramPath,
            blendMode: 'replace',
            order: 0,
            sourceTransform: {
              node: source.node,
              channel: source.channel,
              ...(source.remap ? { remap: source.remap } : {}),
            },
          },
        },
      ],
    };
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
      from: source.ref,
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

/** Numeric spare-param types that can drive a scalar target (the `ch()` road). */
const NUMERIC_SPARE_TYPES = new Set(['float', 'int']);

/**
 * The pickable driver SOURCES — the two roads of the pull rail (#294):
 *  - every node exposing a `Number` output socket (the wired compute road), and
 *  - every promoted-or-not numeric spare param on another node (the `ch()` road).
 * Both EXCLUDE the target node itself (a param cannot be driven by its own node — the
 * trivial self-cycle) and existing ParamDrivers (introspection-only output). Labelled
 * by `meta.name ?? id` and sorted for a stable menu.
 */
export function driverSourceOptions(state: DagState, targetId: string): DriverSource[] {
  const out: DriverSource[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.id === targetId || node.type === 'ParamDriver') continue;
    const label = node.meta?.name?.trim() || node.id;
    const def = getNodeType(node.type);
    if (def) {
      for (const [socket, desc] of Object.entries(def.outputs)) {
        if (desc.type !== 'Number') continue;
        out.push({
          kind: 'output',
          id: `out:${node.id}:${socket}`,
          label: `${label} (${node.type})`,
          ref: { node: node.id, socket },
        });
      }
    }
    // Spare road — a numeric spare param is a first-class source (a Controller knob).
    for (const [key, param] of Object.entries(node.spare ?? {})) {
      if (!NUMERIC_SPARE_TYPES.has(param.type)) continue;
      out.push({
        kind: 'spare',
        id: `spare:${node.id}:${key}`,
        label: `${label} · ${key}`,
        node: node.id,
        key,
      });
    }
    // #296 — transform-channel road: a Null is THE controller, so expose its nine
    // transform channels as driver sources (the primary controller idiom). Scoped to
    // Null in v1 (any transformable object is a follow-up) to keep the picker clean.
    if (node.type === 'Null') {
      for (const channel of TRANSFORM_CHANNELS) {
        out.push({
          kind: 'transform',
          id: `xf:${node.id}:${channel}`,
          label: `${label} · ${channel}`,
          node: node.id,
          channel,
        });
      }
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

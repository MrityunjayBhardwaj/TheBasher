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
import { driverNodesForTarget, driverParamDeps, nextDriverOrder } from './paramDrivers';
import { TRANSFORM_CHANNELS, type TransformChannel } from '../nodes/ParamDriver';

/**
 * A pickable driver source — the two roads of the pull rail (#294):
 *  - `output` — a wired compute-graph Number output (the Inc-2 road): the driver's
 *    `in` is connected to it.
 *  - `spare`  — a promoted numeric spare param on another node (the `ch()` road): the
 *    driver stores the ref in `sourceSpare` and reads it in the resolver seam, no wire.
 */
export type DriverSource =
  | {
      kind: 'output';
      id: string;
      label: string;
      ref: NodeRef;
      /** The source socket's value type. Absent = 'Number' (the scalar road → driver
       *  `in`, byte-identical). 'Vector3' → the vec road (driver `inVec`), for a
       *  Vector3 target. */
      socketType?: 'Number' | 'Vector3';
    }
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
    }
  // #300 F2b — a controller's WHOLE evaluated POSITION as a Vector3 (the "Point
  // controller"): drives a Vector3 target (an object's position, an aim). The driver
  // stores `sourceTransformVec` and reads the vec in the resolver seam, no wire.
  | { kind: 'transformVec'; id: string; label: string; node: string }
  // #300 S — a SPRING follow of a controller: not a plain bind but a preset that builds
  // a tuple-state Solver sub-network (overshoot + settle). Routed to buildSpringOps.
  | { kind: 'spring'; id: string; label: string; node: string };

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
  // #315 — land the new driver on TOP of whatever already drives this band, instead of
  // the hardcoded 0 every road used to write. An empty band → 0 (byte-identical); a
  // SECOND driver on the band → 1, so the two no longer tie and fall back to node-table
  // order. The panel (#316) reorders from here.
  const order = nextDriverOrder(state.nodes, targetId, paramPath);
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
            order,
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
            order,
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
  if (source.kind === 'transformVec') {
    // #300 F2b — the Point-controller road: one edge-less node carrying the controller
    // ref; resolved in the seam via resolveEvaluatedTransform (the whole position vec).
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
            order,
            sourceTransformVec: { node: source.node },
          },
        },
      ],
    };
  }
  if (source.kind === 'spring') {
    // #300 S — a spring is a PRESET (a whole sub-network via buildSpringOps), not a
    // single-driver bind; the UI routes it there. Never bound through this builder.
    return { ok: false, reason: 'spring is authored via buildSpringOps' };
  }
  // A Vector3 source drives a Vector3 target through the driver's `inVec` socket; a
  // Number source through `in`. The driver's evaluate picks the road by which is wired.
  const socket = source.socketType === 'Vector3' ? 'inVec' : 'in';
  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: driverId,
      nodeType: 'ParamDriver',
      params: { target: targetId, paramPath, blendMode: 'replace', order },
    },
    {
      type: 'connect',
      from: source.ref,
      to: { node: driverId, socket },
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

/** A transform-channel range map (#296 S3): the "map the transform to a range" model. */
export interface DriverRemap {
  inMin: number;
  inMax: number;
  outMin: number;
  outMax: number;
}

/**
 * The forward Op that sets (or clears) the range on a transform-channel driver (#296
 * S3, the range UI). A transform driver reads a controller's channel and — with a
 * `remap` — maps it through the range via `fit` in the seam. This rewrites the WHOLE
 * `sourceTransform` object (node + channel preserved) with the new `remap`, or without
 * it when `remap` is null (back to the RAW channel value). `setParam` computes the
 * inverse from the prior value → undo-safe, byte-identical for the raw case.
 *
 * Empty when the driver is missing or is NOT a transform driver (a wired/spare driver
 * has no channel range to author — never a silent write to the wrong shape).
 */
export function buildSetDriverRemapOps(
  state: DagState,
  driverId: string,
  remap: DriverRemap | null,
): Op[] {
  const node = state.nodes[driverId];
  if (!node) return [];
  const src = (
    node.params as {
      sourceTransform?: { node?: unknown; channel?: unknown };
    }
  ).sourceTransform;
  if (!src || typeof src.node !== 'string' || !src.node) return [];
  if (
    typeof src.channel !== 'string' ||
    !TRANSFORM_CHANNELS.includes(src.channel as TransformChannel)
  )
    return [];
  const value = remap
    ? { node: src.node, channel: src.channel, remap }
    : { node: src.node, channel: src.channel };
  return [{ type: 'setParam', nodeId: driverId, paramPath: 'sourceTransform', value }];
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
export function driverSourceOptions(
  state: DagState,
  targetId: string,
  /** The target param's value type. 'number' (default) offers scalar sources (Number
   *  outputs + numeric spares + transform channels); 'vec3' offers Vector3 outputs (a
   *  vector compute chain), which bind through the driver's `inVec` socket. */
  targetKind: 'number' | 'vec3' = 'number',
): DriverSource[] {
  const out: DriverSource[] = [];
  const wantType = targetKind === 'vec3' ? 'Vector3' : 'Number';
  for (const node of Object.values(state.nodes)) {
    if (node.id === targetId || node.type === 'ParamDriver') continue;
    const label = node.meta?.name?.trim() || node.id;
    const def = getNodeType(node.type);
    if (def) {
      for (const [socket, desc] of Object.entries(def.outputs)) {
        if (desc.type !== wantType) continue;
        out.push({
          kind: 'output',
          id: `out:${node.id}:${socket}`,
          label: `${label} (${node.type})`,
          ref: { node: node.id, socket },
          ...(wantType === 'Vector3' ? { socketType: 'Vector3' as const } : {}),
        });
      }
    }
    // The scalar-only source roads (spare knob, transform channel) don't apply to a
    // Vector3 target — a vec target binds to a vector compute output OR a Point
    // controller (a Null's whole position, the #300 F2b road).
    if (targetKind === 'vec3') {
      // #300 F2b — a Null is THE controller; expose its whole evaluated position as a
      // Vector3 source (the "Point controller"), so dragging the Null moves the target.
      // Scoped to Null in v1 (any transformable object is a follow-up), matching the
      // scalar transform-channel road's scoping.
      if (node.type === 'Null') {
        out.push({
          kind: 'transformVec',
          id: `xfvec:${node.id}`,
          label: `${label} · follow`,
          node: node.id,
        });
        // #300 S — a SPRING follow (overshoot + settle) of the same controller.
        out.push({
          kind: 'spring',
          id: `spring:${node.id}`,
          label: `${label} · spring`,
          node: node.id,
        });
      }
      continue;
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

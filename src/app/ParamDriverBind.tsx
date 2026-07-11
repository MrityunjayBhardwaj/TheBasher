// ParamDriverBind — the inspector "bind" affordance on an animatable param (#293,
// Inc 2, decision D-2). The pull-rail authoring surface: a compact control that
// binds a target param to a compute-graph output (creating a ParamDriver on the V88
// rail) or unbinds it. NOT a typed expression, NOT a canvas wire — a source PICKER,
// keyed to the param (the pull mental model), mirroring the look-at-target select
// (`CameraLookAtTarget.tsx`).
//
// Bound → a chip naming the source + an unbind (✕). Unbound → a subtle "drive" link
// that reveals an inline <select> of sources (nodes with a Number output); picking
// one dispatches the bind (cycle-guarded — a rejected bind surfaces a toast, never a
// silent no-op, V38). Inline (not a floating popover) so no overlay-clipping class.
//
// REF: decision D-2; src/app/driverBind.ts (the pure op-builder + cycle guard);
//      src/app/paramDrivers.ts; CameraLookAtTarget.tsx (the select precedent); #293.

import { useMemo, useState } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useDagStore } from '../core/dag/store';
import { useNotificationStore } from './stores/notificationStore';
import {
  buildBindDriverOps,
  buildSetDriverRemapOps,
  buildUnbindDriverOps,
  driverSourceOptions,
  type DriverRemap,
  type DriverSource,
} from './driverBind';
import { driverNodesForTarget } from './paramDrivers';
import { buildSpringOps } from './solverBind';

/** The transform-channel source of a bound driver (#296), if any. A transform driver
 *  reads a controller channel + optionally maps it through a range (the range UI). */
function transformOf(
  driver: { params?: unknown } | null,
): { node: string; channel: string; remap?: DriverRemap } | null {
  const xf = (
    driver?.params as { sourceTransform?: { node?: string; channel?: string; remap?: DriverRemap } }
  )?.sourceTransform;
  if (xf?.node && xf.channel) return { node: xf.node, channel: xf.channel, remap: xf.remap };
  return null;
}

/** Identity range shown when authoring a fresh transform-channel range (raw → raw). */
const DEFAULT_REMAP: DriverRemap = { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };

/** A fresh driver node id. Local (like every other inspector add-node action). */
function newDriverId(): string {
  return `drv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ParamDriverBind({
  nodeId,
  paramPath,
  targetKind = 'number',
}: {
  nodeId: string;
  paramPath: string;
  /** The target param's value type — selects which sources the picker offers (scalar
   *  Number sources vs Vector3 compute outputs). Vec targets bind through `inVec`. */
  targetKind?: 'number' | 'vec3';
}) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  // The ParamDriver bound to THIS (target, param), if any. The node ref is identity-
  // stable across unrelated edits (immutable Ops), so default equality re-renders this
  // control ONLY when the binding actually changes.
  const boundDriver = useStoreWithEqualityFn(
    useDagStore,
    (s) =>
      driverNodesForTarget(s.state.nodes, nodeId).find(
        (d) => (d.params as { paramPath?: unknown }).paramPath === paramPath,
      ) ?? null,
    Object.is,
  );
  const [picking, setPicking] = useState(false);
  // #296 S3 — the range-authoring draft while editing a transform driver's range; null
  // when the range editor is closed. Seeded from the driver's current remap (or the
  // identity default) when opened.
  const [rangeDraft, setRangeDraft] = useState<DriverRemap | null>(null);

  // The transform-channel source of the bound driver, if it reads a controller channel.
  const transform = transformOf(boundDriver);

  // The source label for the bound chip. The transform road (#296) names a controller
  // channel; the `ch()` road (params.sourceSpare) names a promoted spare on another
  // node; the wired road names the node feeding driver.in.
  const sourceLabel = useMemo(() => {
    if (!boundDriver) return '';
    const xf = (boundDriver.params as { sourceTransform?: { node?: string; channel?: string } })
      .sourceTransform;
    if (xf?.node && xf.channel) {
      const src = useDagStore.getState().state.nodes[xf.node];
      return `${src?.meta?.name?.trim() || xf.node} · ${xf.channel}`;
    }
    const spare = (boundDriver.params as { sourceSpare?: { node?: string; key?: string } })
      .sourceSpare;
    if (spare?.node && spare.key) {
      const src = useDagStore.getState().state.nodes[spare.node];
      return `${src?.meta?.name?.trim() || spare.node} · ${spare.key}`;
    }
    // The wired road: a Number source on `in` OR a Vector3 source on `inVec`.
    const inBinding = (boundDriver.inputs?.inVec ?? boundDriver.inputs?.in) as
      | { node?: string }
      | undefined;
    const srcId = inBinding?.node;
    if (!srcId) return 'unwired';
    const src = useDagStore.getState().state.nodes[srcId];
    return src?.meta?.name?.trim() || srcId;
  }, [boundDriver]);

  const bind = (source: DriverSource) => {
    const state = useDagStore.getState().state;
    // #300 S — the SPRING source isn't a plain bind: it dispatches a tuple-state Solver
    // sub-network (overshoot + settle) driving this position from the controller.
    if (source.kind === 'spring') {
      const base = newDriverId();
      const result = buildSpringOps(state, {
        targetId: nodeId,
        paramPath,
        controllerId: source.node,
        idFor: (key) => `${base}_${key}`,
      });
      if (!result.ok) {
        useNotificationStore
          .getState()
          .notify({ severity: 'warn', message: `Can't spring: ${result.reason}` });
        return;
      }
      dispatchAtomic(result.ops, 'user', `spring ${paramPath}`);
      setPicking(false);
      return;
    }
    const result = buildBindDriverOps(state, {
      targetId: nodeId,
      paramPath,
      source,
      driverId: newDriverId(),
    });
    if (!result.ok) {
      useNotificationStore
        .getState()
        .notify({ severity: 'warn', message: `Can't bind: ${result.reason}` });
      return;
    }
    dispatchAtomic(result.ops, 'user', `bind ${paramPath}`);
    setPicking(false);
  };

  const unbind = () => {
    const state = useDagStore.getState().state;
    const ops = buildUnbindDriverOps(state, nodeId, paramPath);
    if (ops.length === 0) return;
    dispatchAtomic(ops, 'user', `unbind ${paramPath}`);
  };

  // #296 S3 — commit (or clear, when `remap` is null) the transform driver's range.
  const saveRange = (remap: DriverRemap | null) => {
    if (!boundDriver) return;
    const ops = buildSetDriverRemapOps(useDagStore.getState().state, boundDriver.id, remap);
    if (ops.length) dispatchAtomic(ops, 'user', `range ${paramPath}`);
    setRangeDraft(null);
  };

  // #296 S3 — the range editor for a transform driver: map "the transform to a range"
  // (in min/max → out min/max), written as one setParam on `sourceTransform`. Transient
  // (only while `rangeDraft` is set) so the compact inspector row isn't permanently
  // widened; reachable from the bound chip's ↔ button and pre-filled from the current
  // remap. "raw" clears the range (reads the channel value directly).
  if (boundDriver && transform && rangeDraft) {
    const upd = (k: keyof DriverRemap, v: string) => {
      const n = parseFloat(v);
      setRangeDraft({ ...rangeDraft, [k]: Number.isFinite(n) ? n : 0 });
    };
    const num = (k: keyof DriverRemap, aria: string) => (
      <input
        type="number"
        step="0.1"
        value={rangeDraft[k]}
        aria-label={aria}
        data-testid={`inspector-driver-range-${k}-${nodeId}-${paramPath}`}
        className="w-12 rounded border border-border bg-muted px-1 py-0.5 text-right font-mono text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => upd(k, e.target.value)}
      />
    );
    return (
      <span
        className="inline-flex flex-wrap items-center gap-1 text-[10px] text-fg/60"
        data-testid={`inspector-driver-range-${nodeId}-${paramPath}`}
      >
        <span className="font-mono text-accent">{transform.channel}</span>
        <span>in</span>
        {num('inMin', `${paramPath} range in min`)}
        {num('inMax', `${paramPath} range in max`)}
        <span aria-hidden>→</span>
        <span>out</span>
        {num('outMin', `${paramPath} range out min`)}
        {num('outMax', `${paramPath} range out max`)}
        <button
          type="button"
          onClick={() => saveRange(rangeDraft)}
          aria-label={`Apply range for ${paramPath}`}
          title="Apply range"
          data-testid={`inspector-driver-range-apply-${nodeId}-${paramPath}`}
          className="select-none px-0.5 leading-none text-fg/50 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ✓
        </button>
        <button
          type="button"
          onClick={() => saveRange(null)}
          aria-label={`Clear range for ${paramPath}`}
          title="Raw — read the channel directly (no range)"
          data-testid={`inspector-driver-range-raw-${nodeId}-${paramPath}`}
          className="select-none px-0.5 font-mono leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          raw
        </button>
        <button
          type="button"
          onClick={() => setRangeDraft(null)}
          aria-label={`Cancel range edit for ${paramPath}`}
          title="Cancel"
          data-testid={`inspector-driver-range-cancel-${nodeId}-${paramPath}`}
          className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ✕
        </button>
      </span>
    );
  }

  if (boundDriver) {
    return (
      <span
        className="flex items-center gap-0.5 text-[10px] text-accent"
        data-testid={`inspector-driver-bound-${nodeId}-${paramPath}`}
        title={`Driven by ${sourceLabel}`}
      >
        <span aria-hidden className="leading-none">
          ⛓
        </span>
        <span className="max-w-[80px] truncate font-mono">{sourceLabel}</span>
        {transform && (
          <button
            type="button"
            onClick={() => setRangeDraft(transform.remap ?? DEFAULT_REMAP)}
            aria-label={`Edit range for ${paramPath}`}
            title="Map the transform to a range"
            data-testid={`inspector-driver-range-open-${nodeId}-${paramPath}`}
            className="select-none px-0.5 leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ↔
          </button>
        )}
        <button
          type="button"
          onClick={unbind}
          aria-label={`Unbind ${paramPath}`}
          title="Unbind (remove driver)"
          data-testid={`inspector-driver-unbind-${nodeId}-${paramPath}`}
          className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ✕
        </button>
      </span>
    );
  }

  if (picking) {
    const options = driverSourceOptions(useDagStore.getState().state, nodeId, targetKind);
    return (
      <select
        autoFocus
        defaultValue=""
        aria-label={`Bind ${paramPath} to a source`}
        data-testid={`inspector-driver-pick-${nodeId}-${paramPath}`}
        className="max-w-[120px] rounded border border-border bg-muted px-1 py-0.5 text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => {
          const opt = options.find((o) => o.id === e.target.value);
          if (opt) bind(opt);
        }}
        onBlur={() => setPicking(false)}
      >
        <option value="" disabled>
          {options.length ? 'source…' : 'no sources'}
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPicking(true)}
      aria-label={`Drive ${paramPath} from a source`}
      title="Drive this param from a compute node"
      data-testid={`inspector-driver-bind-${nodeId}-${paramPath}`}
      className="select-none px-0.5 text-[10px] leading-none text-fg/30 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      ⛓
    </button>
  );
}

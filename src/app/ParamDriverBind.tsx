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
  buildUnbindDriverOps,
  driverSourceOptions,
  type DriverSource,
} from './driverBind';
import { driverNodesForTarget } from './paramDrivers';

/** A fresh driver node id. Local (like every other inspector add-node action). */
function newDriverId(): string {
  return `drv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ParamDriverBind({ nodeId, paramPath }: { nodeId: string; paramPath: string }) {
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

  // The source label for the bound chip. The `ch()` road (params.sourceSpare) names a
  // promoted spare on another node; the wired road names the node feeding driver.in.
  const sourceLabel = useMemo(() => {
    if (!boundDriver) return '';
    const spare = (boundDriver.params as { sourceSpare?: { node?: string; key?: string } })
      .sourceSpare;
    if (spare?.node && spare.key) {
      const src = useDagStore.getState().state.nodes[spare.node];
      return `${src?.meta?.name?.trim() || spare.node} · ${spare.key}`;
    }
    const inBinding = boundDriver.inputs?.in as { node?: string } | undefined;
    const srcId = inBinding?.node;
    if (!srcId) return 'unwired';
    const src = useDagStore.getState().state.nodes[srcId];
    return src?.meta?.name?.trim() || srcId;
  }, [boundDriver]);

  const bind = (source: DriverSource) => {
    const state = useDagStore.getState().state;
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
    const options = driverSourceOptions(useDagStore.getState().state, nodeId);
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

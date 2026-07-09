// LagSourceControls — the inspector affordance for a Lag node's INPUT (#297 S4).
//
// A Lag trails a controller's transform channel over time. This footer control (shown
// only for a Lag) sets WHICH controller channel it trails + the range that channel
// maps through — the same picker + ↔ range editor the driver's transform road uses
// (ParamDriverBind), but writing the Lag's own `sourceTransform`. The `factor` and
// `seedFrame` params render as ordinary rows above; this covers the one nested param.
//
// Authoring flow end to end: add a Null → animate/grab it; add a Lag → point it at the
// Null's channel here; bind the target ← this Lag via the target param's ⛓ affordance
// (the Lag is a Number source). Then the target trails the controller.
//
// REF: src/app/lagBind.ts (op-builders); driverBind.ts (driverSourceOptions +
//      buildSetDriverRemapOps, node-agnostic); ParamDriverBind.tsx (the pattern); #297.

import { useMemo, useState } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useDagStore } from '../core/dag/store';
import {
  driverSourceOptions,
  buildSetDriverRemapOps,
  type DriverRemap,
  type DriverSource,
} from './driverBind';
import { buildSetLagSourceOps } from './lagBind';

const DEFAULT_REMAP: DriverRemap = { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };

interface LagSource {
  node: string;
  channel: string;
  remap?: DriverRemap;
}

export function LagSourceControls({ nodeId }: { nodeId: string }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  // The Lag's current transform source (identity-stable ref → re-renders only when it
  // actually changes).
  const source = useStoreWithEqualityFn(
    useDagStore,
    (s) => {
      const node = s.state.nodes[nodeId];
      if (!node || node.type !== 'Lag') return null;
      const xf = (node.params as { sourceTransform?: LagSource }).sourceTransform;
      return xf?.node && xf.channel ? xf : null;
    },
    Object.is,
  );
  const isLag = useDagStore((s) => s.state.nodes[nodeId]?.type === 'Lag');
  const [picking, setPicking] = useState(false);
  const [rangeDraft, setRangeDraft] = useState<DriverRemap | null>(null);

  const sourceLabel = useMemo(() => {
    if (!source) return '';
    const src = useDagStore.getState().state.nodes[source.node];
    return `${src?.meta?.name?.trim() || source.node} · ${source.channel}`;
  }, [source]);

  if (!isLag) return null;

  const setSource = (opt: DriverSource | null) => {
    const ops = buildSetLagSourceOps(useDagStore.getState().state, nodeId, opt);
    if (ops.length) dispatchAtomic(ops, 'user', 'lag source');
    setPicking(false);
  };

  const saveRange = (remap: DriverRemap | null) => {
    const ops = buildSetDriverRemapOps(useDagStore.getState().state, nodeId, remap);
    if (ops.length) dispatchAtomic(ops, 'user', 'lag range');
    setRangeDraft(null);
  };

  // The transient range editor (map the trailed channel to a range).
  if (source && rangeDraft) {
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
        data-testid={`inspector-lag-range-${k}-${nodeId}`}
        className="w-12 rounded border border-border bg-muted px-1 py-0.5 text-right font-mono text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => upd(k, e.target.value)}
      />
    );
    return (
      <div className="flex flex-col gap-1 border-t border-border px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-fg/40">Lag input range</span>
        <span
          className="inline-flex flex-wrap items-center gap-1 text-[10px] text-fg/60"
          data-testid={`inspector-lag-range-${nodeId}`}
        >
          <span className="font-mono text-accent">{source.channel}</span>
          <span>in</span>
          {num('inMin', 'lag range in min')}
          {num('inMax', 'lag range in max')}
          <span aria-hidden>→</span>
          <span>out</span>
          {num('outMin', 'lag range out min')}
          {num('outMax', 'lag range out max')}
          <button
            type="button"
            onClick={() => saveRange(rangeDraft)}
            aria-label="Apply lag range"
            title="Apply range"
            data-testid={`inspector-lag-range-apply-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/50 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => saveRange(null)}
            aria-label="Clear lag range"
            title="Raw — trail the channel value directly"
            data-testid={`inspector-lag-range-raw-${nodeId}`}
            className="select-none px-0.5 font-mono leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            raw
          </button>
          <button
            type="button"
            onClick={() => setRangeDraft(null)}
            aria-label="Cancel lag range edit"
            title="Cancel"
            data-testid={`inspector-lag-range-cancel-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✕
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-fg/40">Lag trails</span>
      {source ? (
        <span
          className="flex items-center gap-0.5 text-[10px] text-accent"
          data-testid={`inspector-lag-source-${nodeId}`}
          title={`Trailing ${sourceLabel}`}
        >
          <span aria-hidden className="leading-none">
            〜
          </span>
          <span className="max-w-[100px] truncate font-mono">{sourceLabel}</span>
          <button
            type="button"
            onClick={() => setRangeDraft(source.remap ?? DEFAULT_REMAP)}
            aria-label="Edit lag input range"
            title="Map the channel to a range"
            data-testid={`inspector-lag-range-open-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ↔
          </button>
          <button
            type="button"
            onClick={() => setSource(null)}
            aria-label="Clear lag input"
            title="Clear input"
            data-testid={`inspector-lag-clear-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✕
          </button>
        </span>
      ) : picking ? (
        (() => {
          const options = driverSourceOptions(useDagStore.getState().state, nodeId).filter(
            (o) => o.kind === 'transform',
          );
          return (
            <select
              autoFocus
              defaultValue=""
              aria-label="Choose the controller channel to trail"
              data-testid={`inspector-lag-pick-${nodeId}`}
              className="max-w-[140px] rounded border border-border bg-muted px-1 py-0.5 text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onChange={(e) => {
                const opt = options.find((o) => o.id === e.target.value);
                if (opt) setSource(opt);
              }}
              onBlur={() => setPicking(false)}
            >
              <option value="" disabled>
                {options.length ? 'controller channel…' : 'add a Null controller first'}
              </option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        })()
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          aria-label="Set the controller channel this Lag trails"
          title="Trail a controller's transform channel"
          data-testid={`inspector-lag-set-${nodeId}`}
          className="w-fit select-none rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/50 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          〜 trail a controller channel…
        </button>
      )}
    </div>
  );
}

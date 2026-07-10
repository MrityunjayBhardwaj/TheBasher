// SolverControls — the inspector affordance for a Solver meta-op (Epic 2).
//
// A Solver cooks a sub-network every frame with the previous output fed back. This
// footer (shown only for a Solver) authors its TWO links:
//   • Solver body  — pick the sub-network's OUTPUT node (any Number-output compute node);
//                    wires its `out` → Solver.body (buildSetSolverBodyOps). The seam cooks
//                    the closure of whatever is wired here.
//   • Solver input — pick the live controller channel the sub-network reads (its
//                    SolverInput leaves), same picker + ↔ range as Lag (buildSetLagSourceOps
//                    + buildSetDriverRemapOps). Optional (a pure-feedback solver reads 0).
// `seedFrame` renders as an ordinary param row above.
//
// Authoring flow end to end: add a Null → grab/animate it; add Solver + PrevFrame +
// SolverInput + compute nodes; wire the loop rule (e.g. Math(add){PrevFrame, SolverInput});
// point `body` at the rule's output + `input` at the Null's channel here; bind the target
// ← the Solver via the target param's ⛓ affordance (the Solver is a Number source).
//
// REF: src/app/solverBind.ts (body op-builder); lagBind.ts / driverBind.ts (source +
//      range builders, reused); LagSourceControls.tsx (the pattern); src/nodes/Solver.ts.

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
import { buildSetSolverBodyOps } from './solverBind';

const DEFAULT_REMAP: DriverRemap = { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };

// A body output can't itself be a stateful node (nested Solvers/Lag are out of v1 scope).
const STATEFUL_TYPES = new Set(['Solver', 'Lag']);

interface XfSource {
  node: string;
  channel: string;
  remap?: DriverRemap;
}

export function SolverControls({ nodeId }: { nodeId: string }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const isSolver = useDagStore((s) => s.state.nodes[nodeId]?.type === 'Solver');

  // The node wired into `body` (the sub-network output), identity-stable.
  const bodyRef = useStoreWithEqualityFn(
    useDagStore,
    (s) => {
      const node = s.state.nodes[nodeId];
      if (!node || node.type !== 'Solver') return null;
      const b = node.inputs?.body;
      const ref = (Array.isArray(b) ? b[0] : b) as { node: string; socket: string } | undefined;
      return ref?.node ? ref : null;
    },
    (a, b) => a?.node === b?.node && a?.socket === b?.socket,
  );

  // The live controller channel the sub-network reads (its SolverInput leaves).
  const source = useStoreWithEqualityFn(
    useDagStore,
    (s) => {
      const node = s.state.nodes[nodeId];
      if (!node || node.type !== 'Solver') return null;
      const xf = (node.params as { sourceTransform?: XfSource }).sourceTransform;
      return xf?.node && xf.channel ? xf : null;
    },
    Object.is,
  );

  const [pickingBody, setPickingBody] = useState(false);
  const [pickingInput, setPickingInput] = useState(false);
  const [rangeDraft, setRangeDraft] = useState<DriverRemap | null>(null);

  const bodyLabel = useMemo(() => {
    if (!bodyRef) return '';
    const n = useDagStore.getState().state.nodes[bodyRef.node];
    return `${n?.meta?.name?.trim() || bodyRef.node}${n ? ` (${n.type})` : ''}`;
  }, [bodyRef]);
  const sourceLabel = useMemo(() => {
    if (!source) return '';
    const n = useDagStore.getState().state.nodes[source.node];
    return `${n?.meta?.name?.trim() || source.node} · ${source.channel}`;
  }, [source]);

  if (!isSolver) return null;

  const setBody = (ref: { node: string; socket: string } | null) => {
    const ops = buildSetSolverBodyOps(useDagStore.getState().state, nodeId, ref);
    if (ops.length) dispatchAtomic(ops, 'user', 'solver body');
    setPickingBody(false);
  };
  const setSource = (opt: DriverSource | null) => {
    const ops = buildSetLagSourceOps(useDagStore.getState().state, nodeId, opt);
    if (ops.length) dispatchAtomic(ops, 'user', 'solver input');
    setPickingInput(false);
  };
  const saveRange = (remap: DriverRemap | null) => {
    const ops = buildSetDriverRemapOps(useDagStore.getState().state, nodeId, remap);
    if (ops.length) dispatchAtomic(ops, 'user', 'solver input range');
    setRangeDraft(null);
  };

  // The transient range editor for the live input (map the channel to a range).
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
        data-testid={`inspector-solver-range-${k}-${nodeId}`}
        className="w-12 rounded border border-border bg-muted px-1 py-0.5 text-right font-mono text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onChange={(e) => upd(k, e.target.value)}
      />
    );
    return (
      <div className="flex flex-col gap-1 border-t border-border px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-fg/40">Solver input range</span>
        <span
          className="inline-flex flex-wrap items-center gap-1 text-[10px] text-fg/60"
          data-testid={`inspector-solver-range-${nodeId}`}
        >
          <span className="font-mono text-accent">{source.channel}</span>
          <span>in</span>
          {num('inMin', 'solver range in min')}
          {num('inMax', 'solver range in max')}
          <span aria-hidden>→</span>
          <span>out</span>
          {num('outMin', 'solver range out min')}
          {num('outMax', 'solver range out max')}
          <button
            type="button"
            onClick={() => saveRange(rangeDraft)}
            aria-label="Apply solver input range"
            title="Apply range"
            data-testid={`inspector-solver-range-apply-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/50 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => saveRange(null)}
            aria-label="Clear solver input range"
            title="Raw — read the channel value directly"
            data-testid={`inspector-solver-range-raw-${nodeId}`}
            className="select-none px-0.5 font-mono leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            raw
          </button>
          <button
            type="button"
            onClick={() => setRangeDraft(null)}
            aria-label="Cancel solver input range edit"
            title="Cancel"
            data-testid={`inspector-solver-range-cancel-${nodeId}`}
            className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ✕
          </button>
        </span>
      </div>
    );
  }

  const bodyOptions = () =>
    driverSourceOptions(useDagStore.getState().state, nodeId).filter(
      (o) =>
        o.kind === 'output' &&
        !STATEFUL_TYPES.has(useDagStore.getState().state.nodes[o.ref.node]?.type ?? ''),
    );
  const inputOptions = () =>
    driverSourceOptions(useDagStore.getState().state, nodeId).filter((o) => o.kind === 'transform');

  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-2 py-1.5">
      {/* Sub-network output (the loop rule) → Solver.body */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-fg/40">Solver body</span>
        {bodyRef ? (
          <span
            className="flex items-center gap-0.5 text-[10px] text-accent"
            data-testid={`inspector-solver-body-${nodeId}`}
            title={`Cooking ${bodyLabel} each frame`}
          >
            <span aria-hidden className="leading-none">
              ↻
            </span>
            <span className="max-w-[120px] truncate font-mono">{bodyLabel}</span>
            <button
              type="button"
              onClick={() => setBody(null)}
              aria-label="Clear solver body"
              title="Clear the sub-network output"
              data-testid={`inspector-solver-body-clear-${nodeId}`}
              className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              ✕
            </button>
          </span>
        ) : pickingBody ? (
          (() => {
            const options = bodyOptions();
            return (
              <select
                autoFocus
                defaultValue=""
                aria-label="Choose the sub-network output node"
                data-testid={`inspector-solver-body-pick-${nodeId}`}
                className="max-w-[160px] rounded border border-border bg-muted px-1 py-0.5 text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onChange={(e) => {
                  const opt = options.find((o) => o.id === e.target.value);
                  if (opt && opt.kind === 'output') setBody(opt.ref);
                }}
                onBlur={() => setPickingBody(false)}
              >
                <option value="" disabled>
                  {options.length ? 'sub-network output…' : 'add a compute node first'}
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
            onClick={() => setPickingBody(true)}
            aria-label="Set the sub-network output this Solver cooks"
            title="Cook a sub-network's output every frame"
            data-testid={`inspector-solver-body-set-${nodeId}`}
            className="w-fit select-none rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/50 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ↻ cook a sub-network output…
          </button>
        )}
      </div>

      {/* Live input (the controller channel) → SolverInput leaves */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-fg/40">Solver input</span>
        {source ? (
          <span
            className="flex items-center gap-0.5 text-[10px] text-accent"
            data-testid={`inspector-solver-source-${nodeId}`}
            title={`Feeding ${sourceLabel} into SolverInput`}
          >
            <span aria-hidden className="leading-none">
              〜
            </span>
            <span className="max-w-[100px] truncate font-mono">{sourceLabel}</span>
            <button
              type="button"
              onClick={() => setRangeDraft(source.remap ?? DEFAULT_REMAP)}
              aria-label="Edit solver input range"
              title="Map the channel to a range"
              data-testid={`inspector-solver-range-open-${nodeId}`}
              className="select-none px-0.5 leading-none text-fg/40 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              ↔
            </button>
            <button
              type="button"
              onClick={() => setSource(null)}
              aria-label="Clear solver input"
              title="Clear input"
              data-testid={`inspector-solver-clear-${nodeId}`}
              className="select-none px-0.5 leading-none text-fg/40 hover:text-record focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              ✕
            </button>
          </span>
        ) : pickingInput ? (
          (() => {
            const options = inputOptions();
            return (
              <select
                autoFocus
                defaultValue=""
                aria-label="Choose the controller channel to feed in"
                data-testid={`inspector-solver-pick-${nodeId}`}
                className="max-w-[140px] rounded border border-border bg-muted px-1 py-0.5 text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onChange={(e) => {
                  const opt = options.find((o) => o.id === e.target.value);
                  if (opt) setSource(opt);
                }}
                onBlur={() => setPickingInput(false)}
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
            onClick={() => setPickingInput(true)}
            aria-label="Set the controller channel this Solver reads"
            title="Feed a controller's transform channel into the sub-network"
            data-testid={`inspector-solver-set-${nodeId}`}
            className="w-fit select-none rounded border border-border px-1.5 py-0.5 text-[10px] text-fg/50 hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            〜 feed a controller channel…
          </button>
        )}
      </div>
    </div>
  );
}

// PromoteParamControl / PromotedControlRow — the two halves of promote's interface (#394,
// PLAN-3 P7).
//
// ── WHY THE PROMOTE BUTTON SITS BESIDE THE BIND CHIP ────────────────────────────────
//
// "Promotion is itself a driver" (GROUND_TRUTH_HOUDINI_DRIVERS_CONTROLLERS §1), and the
// affordance for authoring a pull relation on a param already exists and already sits on
// every numeric row — `ParamDriverBind`, rendered by `NumericField`. Promote is the same
// act with the source MINTED rather than picked, so it belongs in the same place rather
// than in a surface of its own. It also means the button reaches an operator's rows for
// free: those are ordinary numeric rows in the material card since P3.
//
// ── WHERE THE CONTROL IS HOMED, AND WHY IT IS NOT ASKED ─────────────────────────────
//
// The home is DERIVED: it is the section the target param itself declares, read through
// P6's `paramToSection` off the target node's own `home` table. Promoting
// `MaterialOverrideOp.roughness` therefore puts the knob in the Material card, beside the
// row it came from, and nothing has to be picked or threaded.
//
// A home PICKER is deliberately absent — moving a control to another card is curation, and
// the curation editor is deferred with the procedural-UI epic (PLAN-3 §7). What is here is
// the minimal affordance the stage calls for: promote one row to its own home, and join an
// existing control by naming it.
//
// ── OFFER == ACCEPT, AND WHAT THAT SCOPES ───────────────────────────────────────────
//
// The button appears only where the promote CAN succeed for the row: the param must be a
// declared scalar on its node (`spareTypeForParam`), and the param must not already carry
// a driver band — a param that is already driven has the bind chip instead, and stacking a
// promote under an existing driver would author a relation whose value the user cannot see
// ([[V108]] offer == accept, [[V38]] no silent no-op).
//
// Refusals that are about the user's INPUT rather than about the row — a name that clashes
// with a plain spare, a type that disagrees with the control being joined — are reported
// inline, because hiding those would make a typo indistinguishable from a rule.
//
// REF: src/app/promoteParam.ts (the builders + the host×target matrix in its header),
//      src/app/exposeParams.ts (`PromotedParam` — the read side), src/app/ParamDriverBind.tsx
//      (the sibling affordance), src/app/SpareParamControls.tsx (`SpareValueField` — the
//      SAME knob widget the Controllers dock edits, V34); PLAN-3 §3.6 + §4 P7; #291, #294,
//      #394.

import { useMemo, useState } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useDagStore } from '../core/dag/store';
import type { SpareParam } from '../core/dag/types';
import { useSelectionStore } from './stores/selectionStore';
import { driverStackForTarget } from './paramDrivers';
import { paramToSection, sectionsOf } from './inspectorSections';
import {
  buildPromoteParamOps,
  buildUnpromoteDriveOps,
  resolveControlHost,
  spareTypeForParam,
} from './promoteParam';
import type { PromotedParam } from './exposeParams';
import { SpareValueField } from './SpareParamControls';

/** A fresh driver node id. Local, exactly as the sibling bind affordance mints one. */
function newDriverId(): string {
  return `drv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * The "promote this row to a control" affordance: a compact ⤒ that reveals an inline name
 * field. Renders NOTHING when this row cannot be promoted — see the offer==accept note.
 */
export function PromoteParamControl({ nodeId, paramPath }: { nodeId: string; paramPath: string }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  const selectedId = useSelectionStore((s) => s.selectedNodeId);
  const nodeType = useDagStore((s) => s.state.nodes[nodeId]?.type);
  // Already driven → the bind chip owns this row. Subscribed the same narrow way the bind
  // chip subscribes, so an unrelated edit does not re-render every row in the panel.
  const alreadyDriven = useStoreWithEqualityFn(
    useDagStore,
    (s) => driverStackForTarget(s.state.nodes, nodeId, paramPath, true).length > 0,
    Object.is,
  );
  const spareType = useMemo(() => spareTypeForParam(nodeType, paramPath), [nodeType, paramPath]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(paramPath);
  const [error, setError] = useState<string | null>(null);

  if (spareType === null || alreadyDriven || !selectedId) return null;

  const promote = () => {
    const state = useDagStore.getState().state;
    // The home the TARGET param declares (P6). `paramToSection` is asked rather than a
    // section being guessed here, so a node that re-homes a param moves its control with
    // it and the two answers cannot drift.
    const section = paramToSection(paramPath, sectionsOf(state, nodeId), nodeType);
    // Which control to JOIN is derived, never stored: the host of any promoted row this
    // selection's projection already emits. Absent → mint a Null through the shipped
    // primitive builder. See promoteParam.ts's header for why it can never be the Object.
    const host = resolveControlHost(state, selectedId);
    const objectName = state.nodes[selectedId]?.meta?.name?.trim() || selectedId;
    const result = buildPromoteParamOps(state, {
      target: { nodeId, paramPath },
      control: host
        ? { kind: 'existing', nodeId: host }
        : { kind: 'new', name: `${objectName} Ctl` },
      controlPath: name.trim(),
      // A param that routes to no section gives its control no declared home either, and
      // `''` is an unknown section — which degrades to the UNROUTED bucket, i.e. visible
      // ([[V145]]). Inventing a home here would put the knob in a card the row it came
      // from is not in.
      home: section === null ? { section: '' } : { section },
      driverId: newDriverId(),
    });
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    dispatchAtomic(result.ops, 'user', `promote ${paramPath}`);
    setOpen(false);
    setError(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setName(paramPath);
          setError(null);
          setOpen(true);
        }}
        data-testid={`inspector-promote-${nodeId}-${paramPath}`}
        title={`Promote ${paramPath} to a control`}
        aria-label={`Promote ${paramPath} to a control`}
        className="text-[10px] leading-none text-fg/30 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        ⤒
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <input
        type="text"
        value={name}
        autoFocus
        data-testid={`inspector-promote-name-${nodeId}-${paramPath}`}
        aria-label="Control name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') promote();
          if (e.key === 'Escape') setOpen(false);
        }}
        className="w-20 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <button
        type="button"
        onClick={promote}
        data-testid={`inspector-promote-commit-${nodeId}-${paramPath}`}
        className="text-[10px] leading-none text-accent hover:underline"
      >
        ok
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Cancel promote"
        className="text-[10px] leading-none text-fg/40 hover:text-fg"
      >
        ✕
      </button>
      {error ? (
        <span
          data-testid={`inspector-promote-error-${nodeId}-${paramPath}`}
          className="text-[10px] text-warn"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One promoted control, drawn in the card its `home` names.
 *
 * The knob is `SpareValueField` — the SAME widget the spare-param footer and the
 * Controllers dock edit, writing through the same `setSpareParam` op (V34: two views over
 * one datum, never two spellings of one edit).
 *
 * Each drive gets an unbind, and unbinding removes THAT driver only: the control, its
 * value, its name and its home survive, because a control that evaporated with its last
 * drive would silently reset the interface the user authored (see
 * `buildUnpromoteDriveOps`).
 */
export function PromotedControlRow({ row }: { row: PromotedParam }) {
  const dispatchAtomic = useDagStore((s) => s.dispatchAtomic);
  // The spare IS the control — read it live rather than carrying a copy on the row, so the
  // knob shows what the graph holds. Identity-stable under structural sharing.
  const param = useDagStore((s) => s.state.nodes[row.controlNodeId]?.spare?.[row.controlPath]) as
    | SpareParam
    | undefined;
  const nodes = useDagStore((s) => s.state.nodes);
  if (!param) return null;

  const label = row.home.label ?? row.controlPath;
  const setValue = (next: SpareParam) => {
    dispatchAtomic(
      [{ type: 'setSpareParam', nodeId: row.controlNodeId, key: row.controlPath, param: next }],
      'user',
      `control ${row.controlPath}`,
    );
  };
  const unbind = (driverId: string) => {
    const ops = buildUnpromoteDriveOps(useDagStore.getState().state, driverId);
    if (ops.length === 0) return;
    dispatchAtomic(ops, 'user', `unpromote ${row.controlPath}`);
  };
  const hostName = nodes[row.controlNodeId]?.meta?.name?.trim() || row.controlNodeId;

  return (
    <div
      data-testid={`inspector-promoted-${row.controlNodeId}-${row.controlPath}`}
      className="flex flex-col gap-0.5 px-3 py-1.5 text-[11px] text-fg/80"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <span className="text-[10px] leading-none text-accent" title={`Control on ${hostName}`}>
            ⤒
          </span>
          <span className="select-none font-mono text-fg/60">{label}</span>
        </span>
        <span className="w-24">
          <SpareValueField
            param={param}
            onChange={setValue}
            testId={`inspector-promoted-value-${row.controlNodeId}-${row.controlPath}`}
          />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-4">
        {row.drives.map((d) => (
          <span
            key={d.driverId}
            data-testid={`inspector-promoted-drive-${d.driverId}`}
            className="flex items-center gap-0.5 rounded bg-bg-1 px-1 font-mono text-[9px] text-fg/40"
          >
            {(nodes[d.nodeId]?.meta?.name?.trim() || d.nodeId) + ' · ' + d.paramPath}
            <button
              type="button"
              onClick={() => unbind(d.driverId)}
              title={`Stop driving ${d.paramPath}`}
              aria-label={`Stop driving ${d.paramPath}`}
              className="text-fg/30 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

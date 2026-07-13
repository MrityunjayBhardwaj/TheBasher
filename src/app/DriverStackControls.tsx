// DriverStackControls — the DRIVER (relational CHOP → param) binding of the shared stack
// panel (#316). The THIRD caller of OperatorStackRows, and the point of that component:
// a new operator stack costs an enumerator and a set of op-builders, not a new row UI.
//
// Same rows as the Modifiers and Constraints panels. What differs, and stays here:
//   - enumeration : driverBandsForTarget — an edge-less set keyed by (target, paramPath).
//   - op-builders : driverStack.ts — mute/move are `mute`/`order` field writes.
//
// ONE STACK PER BAND, not one per object. An object has a single constraint stack but as
// many driver stacks as it has driven params, because the fold groups by paramPath: two
// drivers contend only when they write the SAME param. Rendering them as one flat list
// would imply an ordering between a driver on `intensity` and one on `position` that the
// engine does not have. So each band gets its own rows, under its param path.
//
// No "+ Add" here (`addable={[]}`): a driver needs a SOURCE to mean anything, and the
// source picker lives on the param row (ParamDriverBind), where the band is already known.
// This panel is where you SEE the stack you built — order it, bypass it, remove it — which
// is exactly what was impossible before: two drivers on one param used to be invisible and
// unbypassable.
//
// REF: src/app/OperatorStackRows.tsx (the shared rows); src/app/driverStack.ts (the
//      builders); src/app/paramDrivers.ts (the fold these rows describe);
//      src/app/ConstraintStackControls.tsx (the pose twin).

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { OperatorStackRows } from './OperatorStackRows';
import {
  buildMoveDriverOps,
  buildRemoveDriverOps,
  buildToggleDriverMuteOp,
  driverBandsForTarget,
} from './driverStack';

const NONE: ReadonlyArray<{ type: string; label: string }> = [];

/** The object a driver row belongs to. Select the driven OBJECT and you see its stacks;
 *  select a DRIVER in one of them and you still see the same stacks (its own `target`) —
 *  the modifier/constraint panel idiom, so a selected driver shows the stack it belongs to
 *  AND its own params in the ParamRows below. */
function resolveDriverTarget(
  state: ReturnType<typeof useDagStore.getState>['state'],
  nodeId: string,
): string {
  const node = state.nodes[nodeId];
  if (node?.type === 'ParamDriver') {
    const t = (node.params as { target?: unknown }).target;
    if (typeof t === 'string' && t && state.nodes[t]) return t;
  }
  return nodeId;
}

export function DriverStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  const target = resolveDriverTarget(state, nodeId);
  const bands = driverBandsForTarget(state, target);

  function onMute(id: string) {
    const op = buildToggleDriverMuteOp(useDagStore.getState().state, id);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle driver mute');
  }
  function onMove(id: string, dir: 'up' | 'down') {
    const ops = buildMoveDriverOps(useDagStore.getState().state, id, dir);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder driver');
  }
  function onRemove(id: string) {
    const ops = buildRemoveDriverOps(useDagStore.getState().state, id);
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'remove driver');
      if (selectedNodeId === id) select(target); // don't strand the selection on a deleted node
    }
  }

  if (bands.length === 0) {
    return (
      <OperatorStackRows
        testIdPrefix="driver"
        entries={[]}
        addable={NONE}
        selectedNodeId={selectedNodeId}
        emptyLabel="No drivers. Bind one from a parameter row."
        onSelect={select}
        onMute={onMute}
        onMove={onMove}
        onRemove={onRemove}
        onAdd={() => {}}
      />
    );
  }

  return (
    <div data-testid="driver-bands" className="flex flex-col gap-2">
      {bands.map((band) => (
        <div key={band.paramPath} className="flex flex-col gap-1">
          <p
            data-testid={`driver-band-${band.paramPath}`}
            className="px-1 font-mono text-[10px] text-fg/60"
            title={band.paramPath}
          >
            → {band.paramPath}
          </p>
          <OperatorStackRows
            testIdPrefix="driver"
            entries={band.entries}
            addable={NONE}
            selectedNodeId={selectedNodeId}
            emptyLabel="No drivers."
            onSelect={select}
            onMute={onMute}
            onMove={onMove}
            onRemove={onRemove}
            onAdd={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

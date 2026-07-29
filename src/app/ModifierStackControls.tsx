// ModifierStackControls — the GEOMETRY stack (SOP) binding of the shared stack panel
// (epic #201, #209, V58; re-cut onto OperatorStackRows in #312). The Blender modifier
// stack: for the selected mesh (the base, or any modifier in its chain) it lists the
// stack bottom→top, with per-row mute / reorder / delete, and "+ Add Modifier".
//
// This file owns only what is GEOMETRY-SPECIFIC:
//   - enumeration  : enumerateModifierStack — an edge-wired sub-chain walk.
//   - op-builders  : operatorStack.ts — add/move/remove are RE-WIRING.
//   - the unsupported-source banner (a modifier only reshapes a primitive leaf mesh).
// The rows themselves (mute ●/◌, reorder ▲▼, remove ✕, + Add) are the shared
// OperatorStackRows, which the CONSTRAINT stack renders too — the presentation is the
// genuine overlap; the enumeration and the builders are not (a constraint is edge-less,
// so it can't be a sub-chain).
//
// It renders for both a selected mesh-producer (Box/Sphere — the base) AND a selected
// modifier (resolveStackBase walks down to the base), so the same stack shows whichever
// the user picked. Clicking a row selects that modifier so its params (count/offset)
// edit in the same section's ParamRows below.
//
// REF: src/app/OperatorStackRows.tsx (the shared rows); src/app/operatorStack.ts;
//      src/nodes/ArrayModifier.ts; src/app/NPanel.tsx (renders this in the 'modifier'
//      section); vyapti V58.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { canModifyGeometry, resolveDataKind } from './modifierGeometry';
import { dataSectionCapability } from './dataSectionCapability';
import { OperatorStackRows } from './OperatorStackRows';
import {
  buildAddModifierOps,
  buildMoveModifierOps,
  buildRemoveModifierOps,
  buildToggleModifierMuteOp,
  enumerateModifierStack,
  resolveStackBase,
} from './operatorStack';

/** The modifiers the user can add from the "+ Add" menu. New modifiers join here
 *  + MODIFIER_NODE_TYPES + the agent ModifierType enum + registerAll. */
const ADDABLE: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'ArrayModifier', label: 'Array' },
  { type: 'MirrorModifier', label: 'Mirror' },
];

/** #498 — a module constant, not a fresh `[]` per render, so the rows keep a stable
 *  prop identity on the refused path exactly as they do on the offered one. */
const EMPTY_ADDABLE: ReadonlyArray<{ type: string; label: string }> = [];

/** #256 (V38) — a geometry modifier only rewrites mesh data; on non-mesh data it passes
 *  THROUGH unchanged. Silently doing nothing reads as "the modifier is broken", so the
 *  banner says so instead.
 *
 *  #377/[[V108]] — this used to be `new Set(['BoxMesh','SphereMesh','BakedMesh'])`,
 *  which drifted in BOTH directions at once: `BoxMesh` retired in Slice 2 and was
 *  still listed, while the `Object` a cube actually is had never been added, so the
 *  banner declared every cube unsupported. The offer now asks the SAME predicate the
 *  modifier's `evaluate` accepts. Do not reintroduce a type list here.
 *
 *  #415 SHRANK WHAT THIS BANNER IS FOR, which is a good outcome rather than a loss. It
 *  used to explain a Group or a glTF import passing through — sources that were only
 *  ever wireable because `target` took the widest socket in the app. On the data lane
 *  `target` takes `ObjectData`, so those cannot be connected at all: the connect check
 *  refuses them, and the case the banner explained stops existing. What remains is
 *  genuine and narrower — mesh data can be reshaped, curve/light/camera data cannot. */

export function ModifierStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  const base = resolveStackBase(state, nodeId);
  const stack = enumerateModifierStack(state, base);

  // #498 — the OFFER now asks the same predicate the accept does, instead of computing
  // it and using it only to pick a banner. `addable` is derived rather than static: an
  // add that `buildAddModifierOps` would refuse is not shown at all, so the panel cannot
  // advertise an action that silently does nothing.
  const canAdd = canModifyGeometry(state, base);
  const addable = canAdd ? ADDABLE : EMPTY_ADDABLE;

  // The three-state answer, which `canModifyGeometry` alone cannot give: it is false for
  // a curve, a light and a camera alike, and those do not deserve the same sentence. A
  // curve is a tracked gap (#349); a camera has nothing to reshape and never will.
  const dataKind = resolveDataKind(state, base);
  const capability = dataKind ? dataSectionCapability(dataKind, 'modifier') : null;

  // The residual banner: modifiers are present on a source that cannot be reshaped and
  // whose kind did not explain why (an un-evaluable source — a cycle or a dangling ref).
  const unsupportedSource = stack.length > 0 && !canAdd;

  // PRESENTATION ONLY — names the source in the banner. It must never become the
  // gate again (#377): `canModifyGeometry` above is the single source of truth.
  const baseType = state.nodes[base]?.type;

  function onAdd(type: string) {
    const res = buildAddModifierOps(useDagStore.getState().state, base, type);
    if (res) useDagStore.getState().dispatchAtomic(res.ops, 'user', 'add modifier');
  }
  function onMute(id: string) {
    const op = buildToggleModifierMuteOp(useDagStore.getState().state, id);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle modifier mute');
  }
  function onMove(id: string, dir: 'up' | 'down') {
    const ops = buildMoveModifierOps(useDagStore.getState().state, id, dir);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder modifier');
  }
  function onRemove(id: string) {
    const ops = buildRemoveModifierOps(useDagStore.getState().state, id);
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'remove modifier');
      if (selectedNodeId === id) select(base); // don't strand the selection on a deleted node
    }
  }

  return (
    <OperatorStackRows
      testIdPrefix="modifier"
      entries={stack}
      addable={addable}
      selectedNodeId={selectedNodeId}
      emptyLabel="No modifiers."
      onSelect={select}
      onMute={onMute}
      onMove={onMove}
      onRemove={onRemove}
      onAdd={onAdd}
      banner={
        // #498 — the banner now fires on the CAPABILITY, not on `stack.length > 0`. It
        // used to explain modifiers that were already there and doing nothing; with the
        // add refused, the section would otherwise be silently empty and the user would
        // be left to guess why there is no "+ Add".
        capability?.state === 'never' ? (
          <p
            data-testid="modifier-not-applicable"
            className="rounded border border-border-strong bg-bg-2 px-1.5 py-1 text-fg-dim"
          >
            Modifiers reshape mesh data. {baseType} has no geometry to rewrite, so this stack stays
            empty.
          </p>
        ) : capability?.state === 'not-yet' ? (
          <p
            data-testid="modifier-unsupported-source"
            className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
          >
            ⚠ Modifiers do not reshape {baseType} yet. This is a gap rather than a limit — see issue
            #{capability.issue}.
          </p>
        ) : unsupportedSource ? (
          // The residual case: a source that IS a modifiable kind but could not be
          // evaluated (a cycle, a dangling ref). Rare, and worth its own sentence rather
          // than being folded into either answer above.
          <p
            data-testid="modifier-unsupported-source"
            className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
          >
            ⚠ Modifiers only reshape mesh data (Box, Sphere, baked). This {baseType} source passes
            through unchanged.
          </p>
        ) : null
      }
    />
  );
}

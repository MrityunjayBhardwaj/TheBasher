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
import { canModifyGeometry } from './modifierGeometry';
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

/** #256 (V38) — a geometry modifier only rewrites a leaf mesh; on a glTF / Group /
 *  other source it passes THROUGH unchanged (async geometry is a documented v1
 *  follow-up). Silently doing nothing reads as "the modifier is broken" on an
 *  imported asset, so the banner says so instead.
 *
 *  #377/[[V108]] — this used to be `new Set(['BoxMesh','SphereMesh','BakedMesh'])`,
 *  which drifted in BOTH directions at once: `BoxMesh` retired in Slice 2 and was
 *  still listed, while the `Object` a cube actually is had never been added, so the
 *  banner declared every cube unsupported. The offer now asks the SAME predicate the
 *  modifier's `evaluate` accepts. Do not reintroduce a type list here. */

export function ModifierStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  const base = resolveStackBase(state, nodeId);
  const stack = enumerateModifierStack(state, base);

  const unsupportedSource = stack.length > 0 && !canModifyGeometry(state, base);
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
      addable={ADDABLE}
      selectedNodeId={selectedNodeId}
      emptyLabel="No modifiers."
      onSelect={select}
      onMute={onMute}
      onMove={onMove}
      onRemove={onRemove}
      onAdd={onAdd}
      banner={
        unsupportedSource ? (
          <p
            data-testid="modifier-unsupported-source"
            className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
          >
            ⚠ Modifiers only reshape primitive meshes (Box, Sphere). This{' '}
            {baseType === 'GltfAsset' ? 'imported' : baseType} source passes through unchanged.
          </p>
        ) : null
      }
    />
  );
}

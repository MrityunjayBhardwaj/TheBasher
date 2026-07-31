// MaterialStackControls — the MATERIAL stack binding of the shared stack panel (#394
// S3d-b). The FOURTH caller of `OperatorStackRows`, after geometry (#209), constraints
// (#312) and drivers (#316), and the second one that lives on the data lane.
//
// This file owns only what is MATERIAL-SPECIFIC:
//   - enumeration : enumerateMaterialStack — the same sub-chain walk the geometry stack
//                   uses, filtered to material-lane operators and PASSING THROUGH the
//                   geometry ones (#526: one physical lane, two stacks).
//   - op-builders : operatorStack.ts — add/move/remove are RE-WIRING, exactly as they are
//                   for a modifier, because a material operator is the same shape of node.
//   - the capability banner, which is a different sentence from the modifier one.
// The rows themselves are the shared presentation. Nothing here re-implements them.
//
// ── WHY IT DOES NOT SIMPLY MIRROR ModifierStackControls ────────────────────────────
//
// Two differences, both structural rather than cosmetic:
//
// 1. THE SECTION IS DECLARED BY THE DATA NODE, NOT BY THE OBJECT. `ObjectNode` declares
//    'modifier' unconditionally, so the modifier panel needs the capability table to
//    qualify a section that would otherwise render on a camera. 'material' is declared by
//    `BoxData`/`SphereData`/`BakedData` and by nothing that cannot wear one, so the
//    section hides itself. What the table is doing HERE is gating the ADD — see
//    `buildAddMaterialOpOps`, which is where the refusal actually lives (#498's rule).
//
// 2. IT RENDERS ON NODES THAT ARE NOT ON THE DATA LANE AT ALL. `Material`,
//    `MaterialOverride`, `GltfChild`, `GltfAsset` and `ScatterNode` all declare the
//    'material' section, and none of them is a data-lane source: a Material node is what
//    the lane POINTS AT, and the glTF/scatter nodes emit `SceneObject`. For those,
//    `resolveDataKind` answers null and this component renders NOTHING — not an empty
//    stack with an "+ Add" the builder would refuse, and not a banner, because there is
//    no gap to explain. A stack panel on a Material node would be a category error, and
//    an empty one there reads as "this material has no operators yet", which is a
//    sentence about the wrong noun.
//
// REF: src/app/OperatorStackRows.tsx (the shared rows); src/app/operatorStack.ts
//      (enumerateMaterialStack + the material builders); src/app/dataSectionCapability.ts
//      (the three-state answer, grounded on the Blender 5.1 datablock properties);
//      src/nodes/SetMaterialOp.ts + src/nodes/MaterialOverrideOp.ts (the two members);
//      src/app/NPanel.tsx (renders this in the 'material' section). Issues #394, #526,
//      #498, #528; vyapti V58, V108.

import { useDagStore } from '../core/dag/store';
import { useSelectionStore } from './stores/selectionStore';
import { canWearMaterial, resolveDataKind } from './modifierGeometry';
import { dataSectionCapability } from './dataSectionCapability';
import { OperatorStackRows } from './OperatorStackRows';
import {
  buildAddMaterialOpOps,
  buildMoveMaterialOpOps,
  buildRemoveMaterialOpOps,
  buildToggleMaterialOpMuteOp,
  enumerateMaterialStack,
  resolveStackBase,
} from './operatorStack';

/** The material operators the user can add from the "+ Add" menu.
 *
 *  These are the two members of `MATERIAL_LANE_TYPES`, in the order the composition
 *  reads: SET replaces the material flowing through, OVERRIDE authors a sparse set of
 *  fields over it. A new material operator joins here AND in `MATERIAL_LANE_TYPES` —
 *  and that second list is a tuple whose per-field ownership switch closes on a `never`,
 *  so the compiler already refuses a member nobody taught the mask about. */
const ADDABLE: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'SetMaterialOp', label: 'Set Material' },
  { type: 'MaterialOverrideOp', label: 'Override' },
];

/** #498's idiom — a module constant rather than a fresh `[]` per render, so the rows
 *  keep a stable prop identity on the refused path exactly as on the offered one. */
const EMPTY_ADDABLE: ReadonlyArray<{ type: string; label: string }> = [];

export function MaterialStackControls({ nodeId }: { nodeId: string }) {
  const state = useDagStore((s) => s.state);
  const selectedNodeId = useSelectionStore((s) => s.selectedNodeId);
  const select = useSelectionStore((s) => s.select);

  // The same walk the geometry stack does: from a data node it is identity, from a
  // material operator (which declares 'material' and so renders this panel when
  // selected) it walks DOWN the lane to the data node the stack hangs off.
  const base = resolveStackBase(state, nodeId);

  // Not a data-lane source at all — a Material node, a glTF child, the scene-band
  // `MaterialOverride`. There is no stack here and there never will be. Render nothing
  // rather than an empty one (see the header).
  const dataKind = resolveDataKind(state, base);
  if (dataKind === null) return null;

  const capability = dataSectionCapability(dataKind, 'material');
  const stack = enumerateMaterialStack(state, base);

  // The OFFER asks the same predicate the ACCEPT does, so the panel cannot advertise an
  // action `buildAddMaterialOpOps` would refuse ([[V108]]). It is deliberately the
  // predicate and not `capability.state === 'supported'` spelled again here: one
  // phrasing, two readers.
  const addable = canWearMaterial(state, base) ? ADDABLE : EMPTY_ADDABLE;

  function onAdd(type: string) {
    const res = buildAddMaterialOpOps(useDagStore.getState().state, base, type);
    if (res) useDagStore.getState().dispatchAtomic(res.ops, 'user', 'add material operator');
  }
  function onMute(id: string) {
    const op = buildToggleMaterialOpMuteOp(useDagStore.getState().state, id);
    if (op) useDagStore.getState().dispatchAtomic([op], 'user', 'toggle material operator mute');
  }
  function onMove(id: string, dir: 'up' | 'down') {
    const ops = buildMoveMaterialOpOps(useDagStore.getState().state, id, dir);
    if (ops) useDagStore.getState().dispatchAtomic(ops, 'user', 'reorder material operator');
  }
  function onRemove(id: string) {
    const ops = buildRemoveMaterialOpOps(useDagStore.getState().state, id);
    if (ops) {
      useDagStore.getState().dispatchAtomic(ops, 'user', 'remove material operator');
      // Don't strand the selection on a deleted node — the same courtesy the modifier
      // stack does, and for the same reason: the row the user clicked is gone.
      if (selectedNodeId === id) select(base);
    }
  }

  return (
    <OperatorStackRows
      testIdPrefix="material-op"
      entries={stack}
      addable={addable}
      selectedNodeId={selectedNodeId}
      emptyLabel="No material operators."
      onSelect={select}
      onMute={onMute}
      onMove={onMove}
      onRemove={onRemove}
      onAdd={onAdd}
      banner={
        // Only the 'not-yet' sentence can be reached from here today: a 'never' kind
        // (light, camera) declares no 'material' section, so this component never
        // mounts for one. Kept anyway rather than asserted away — the section list and
        // this table are two declarations that could drift apart, and the banner is the
        // honest thing to show if they ever do.
        capability.state === 'not-yet' ? (
          <p
            data-testid="material-op-not-yet"
            className="rounded border border-border-strong bg-warn/10 px-1.5 py-1 text-warn"
          >
            ⚠ {dataKind} cannot carry a material yet. This is a gap rather than a limit — see issue
            #{capability.issue}.
          </p>
        ) : capability.state === 'never' ? (
          <p
            data-testid="material-op-not-applicable"
            className="rounded border border-border-strong bg-bg-2 px-1.5 py-1 text-fg-dim"
          >
            A material describes how a surface responds to light. {dataKind} has no surface, so this
            stack stays empty.
          </p>
        ) : null
      }
    />
  );
}

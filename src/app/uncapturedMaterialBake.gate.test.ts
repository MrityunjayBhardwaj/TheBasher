// #605 item 2 — a bake may not silently discard a material it never captured.
//
// ── WHY THIS GATE EXISTS ────────────────────────────────────────────────────────────────
//
// `absentSlot` (#605 item 2) split one `null` into two meanings — "this slot has no material"
// and "a mounted asset clone owns what draws and we hold no capture of it" — and `slotMaterialAt`
// is the road that tells them apart. Two of the four named consumers were moved onto that road.
// The other two still go through `primaryMaterial`, whose return type is `M | null` and therefore
// has nowhere to put the difference.
//
// At the UV editor that collapse costs a texture. At the BAKE it costs a material: Apply wrote a
// spec with no material for a mesh the asset clone is drawing in one. That is the same failure
// `multiMaterialBakeRefusal` already exists to prevent — data loss with good manners — one
// material short instead of one material too many.
//
// 🔴 EVERY ROW IS STATED AGAINST BOTH A CLONE-BACKED AND A REGISTRY-BUILT HANDLE, because the
// only axis that distinguishes the two absences is where the buffers live. A row over one handle
// alone passes with the whole derivation deleted.

import { describe, it, expect } from 'vitest';
import type { GeometryRef, InlineMaterialSpec, MaterialAssignment } from '../nodes/types';
import { materialAssignmentOf, primaryMaterial, slotMaterialAt } from './materialAssignment';
import {
  multiMaterialBakeRefusal,
  uncapturedMaterialBakeRefusal,
} from './animate/dispatchApplyTransform';

const BOX: GeometryRef = {
  key: 'box|1,1,1',
  descriptor: { kind: 'box', size: { x: 1, y: 1, z: 1 } },
};
const CLONE: GeometryRef = {
  key: 'gltf|asset-a|Cube',
  descriptor: { kind: 'gltf', assetRef: 'asset-a', childName: 'Cube' },
};
const RED = { color: '#ff0000' } as unknown as InlineMaterialSpec;

describe('#605 item 2 — the bake refuses a material it never captured', () => {
  it('refuses on a clone-backed mesh whose slot we hold no capture of', () => {
    const elsewhere = materialAssignmentOf(null, [null], CLONE);

    // The collapse this gate exists for: the value the bake would carry is the SAME one a
    // genuinely materialless mesh gives.
    expect(primaryMaterial(elsewhere)).toBeNull();
    expect(slotMaterialAt(elsewhere, 0)).toEqual({ status: 'elsewhere' });

    const refusal = uncapturedMaterialBakeRefusal('imported-cube', elsewhere);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('imported-cube');
    // The message has to point at the thing to change, not merely stop.
    expect(refusal).toMatch(/no capture|owned by its imported asset/);
  });

  it('🔴 does NOT refuse the registry-built mesh with the identical slot value', () => {
    // The control that makes the row above about WHERE THE BUFFERS LIVE rather than about a
    // null slot. Same `[null]` slots, same `primaryMaterial`, opposite verdict.
    const none = materialAssignmentOf(null, [null], BOX);

    expect(primaryMaterial(none)).toBeNull();
    expect(primaryMaterial(none)).toBe(primaryMaterial(materialAssignmentOf(null, [null], CLONE)));
    expect(uncapturedMaterialBakeRefusal('plain-box', none)).toBeNull();
  });

  it('does not refuse a clone-backed mesh whose material we DID capture', () => {
    // `absentSlot` says what an ABSENCE would mean; it is not a statement that the mesh is
    // unbakeable. Keying the refusal off the field directly rather than through the road would
    // refuse this, and refusing a mesh whose material is right there is its own defect.
    const captured = materialAssignmentOf(null, [RED], CLONE);

    expect(slotMaterialAt(captured, 0).status).toBe('ok');
    expect(uncapturedMaterialBakeRefusal('imported-cube', captured)).toBeNull();
  });

  it('a mesh with no slots at all is not refused by this rule', () => {
    // There is no slot 0, so `slotMaterialAt` answers `no-such-slot` and this refusal has no
    // opinion. Whatever that case should do, it is not this function's question — and saying so
    // out loud keeps a third meaning from being folded into the 'elsewhere' arm later.
    const empty = materialAssignmentOf(null, [], CLONE);

    expect(slotMaterialAt(empty, 0)).toEqual({ status: 'no-such-slot' });
    expect(uncapturedMaterialBakeRefusal('imported-cube', empty)).toBeNull();
  });
});

describe('#605 item 2 — the two refusals are siblings, not one widened rule', () => {
  // ⚠️ WRITTEN AS A LITERAL, AND THE REASON IS THE MINTER'S OWN. `materialAssignmentOf` derives
  // `indices` from a per-face attribute in the store, and with no attribute key `assignedSlots`
  // answers slot 0 alone — so the minter CANNOT produce a two-material assignment inline, and a
  // first version of this row passed a two-slot array and measured one. The multi-material case
  // is real (the standing two-material fixture builds it through the DAG); what is synthetic
  // here is only the shortcut to it, which is the same licence `materialAssignment.ts` takes for
  // its own unreachable-input rows.
  const multiMaterial = (geometry: GeometryRef): MaterialAssignment<InlineMaterialSpec | null> => ({
    slots: [RED, RED],
    indices: [0, 0, 0, 1, 1, 1],
    absentSlot: geometry === CLONE ? 'elsewhere' : 'none',
  });

  it('each fires on its own case and neither covers the other', () => {
    const twoMaterials = multiMaterial(CLONE);
    const oneUncaptured = materialAssignmentOf(null, [null], CLONE);

    // Multi-material: the old refusal fires, the new one has nothing to say.
    expect(multiMaterialBakeRefusal('x', twoMaterials)).not.toBeNull();
    // One uncaptured material: the new refusal fires, the old one has nothing to say.
    expect(multiMaterialBakeRefusal('x', oneUncaptured)).toBeNull();
    expect(uncapturedMaterialBakeRefusal('x', oneUncaptured)).not.toBeNull();
  });

  it('their messages give different advice, which is why they are two functions', () => {
    // "Reduce it to a single material" is useless for a mesh whose one material is fine and
    // merely unreadable from here. Merging them would have to pick one sentence for both.
    const multi = multiMaterialBakeRefusal('x', multiMaterial(BOX));
    const uncaptured = uncapturedMaterialBakeRefusal(
      'x',
      materialAssignmentOf(null, [null], CLONE),
    );

    expect(multi).not.toEqual(uncaptured);
    expect(multi).toContain('single material');
    expect(uncaptured).not.toContain('single material');
  });
});

// perMapPlacementEdit — the inspector's read/write rule over a material's per-map UV
// placement bag (#550, the inspector slice).
//
// ── WHY THIS IS A MODULE AND NOT THREE LINES IN THE PANEL ─────────────────────
//
// `NPanel.tsx` is one large component with no unit tier, so a rule written inline
// there is observable only through the 34-minute browser suite. The rule is small
// but it has a silent failure mode, which is the combination that earns a module:
//
//   · WHICH slots get a row comes from the IR's closed slot table, never from
//     `Object.keys(bag)` — the bag's own key order is an accident of whichever
//     textures the imported glTF happened to transform, so rows would reorder
//     themselves between two materials that differ only in import order.
//
//   · A RESET must leave the slot's key genuinely ABSENT, and when the last entry
//     goes, the FIELD must be absent too. `{...mat, mapUvTransforms: undefined}` and
//     `{...mat, mapUvTransforms: {}}` both read as "no per-map placement" and render
//     identically — and both key DIFFERENTLY from a material that never carried the
//     field, because `materialKeyOf` walks own enumerable keys. The result is a cache
//     that re-mints every material with nothing visible to explain it. `JSON.stringify`
//     then DROPS an undefined-valued key while `Object.keys` counts it, so the live
//     object and its saved-then-reloaded twin disagree about the same material.
//     ⇒ this module owns the field's PRESENCE; the panel cannot reintroduce it.
//     See `src/nodes/types.ts` on `mapUvTransforms`, and #550.
//
// Rebuilding the bag from the slot table (rather than spreading the old one) also
// makes the key order canonical, so two materials with the same placements produce
// the same key regardless of the order the entries were captured or edited in.
//
// ── THE ROAD, stated because the value does not carry it ──────────────────────
//
// These rows belong to the glTF material editor, whose road applies placements about
// the UV ORIGIN — the KHR_texture_transform convention the import captured. This
// module is a PASS-THROUGH: it moves the road's own stored numbers in and out with no
// pivot conversion. A conversion here would be a third spelling of a placement rule
// `uvPlacement.ts` already owns, and the pivot travels with the ROAD, not the value.
// The authored editor (centre pivot) has no per-map rows in this slice, so no per-map
// value is authored on one road and read by the other. → #551 for the divergence.
//
// REF: src/app/material/uvPlacement.ts (`resolveSlotPlacement` — the READ side of the
//      same replacement rule; this is its WRITE side), src/nodes/materialSchema.ts
//      (`MAP_UV_SLOTS`, the closed table; `hydrateInlineMaterial`, the parse road that
//      makes the same absent-when-empty decision), src/app/NPanel.tsx (the only
//      consumer — the glTF material editor); issues #550, #551, #217, #181.

import { MAP_UV_SLOTS } from '../../nodes/materialSchema';
import type { InlineMaterialMaps, UvPlacement } from '../../nodes/types';

/** A map slot in the IR's own vocabulary (`albedo` / `normal` / …). */
export type IrMapSlot = keyof InlineMaterialMaps;

/** Anything material-shaped that may carry the bag — the panel holds loose records. */
export interface PerMapPlacementHost {
  readonly mapUvTransforms?: { readonly [K in IrMapSlot]?: UvPlacement };
}

/** One editable per-map row: the slot, and the absolute placement it draws with. */
export interface PerMapPlacementRow {
  readonly slot: IrMapSlot;
  readonly placement: UvPlacement;
}

/**
 * The slots that carry their OWN placement, in the IR table's order. A slot with no
 * entry is absent from this list on purpose: it uses the material's shared placement,
 * which the panel already shows above these rows.
 */
export function perMapPlacementRows(mat: PerMapPlacementHost): readonly PerMapPlacementRow[] {
  const bag = mat.mapUvTransforms;
  if (!bag) return [];
  const rows: PerMapPlacementRow[] = [];
  for (const slot of MAP_UV_SLOTS) {
    const placement = bag[slot];
    if (placement) rows.push({ slot, placement });
  }
  return rows;
}

/**
 * Set one slot's own placement, or clear it with `null` so the slot falls back to the
 * shared one. Returns a new material; the field is present only while some slot has an
 * entry — see the header for why an empty bag is not the same as no bag.
 */
export function withSlotPlacement<T extends PerMapPlacementHost>(
  mat: T,
  slot: IrMapSlot,
  placement: UvPlacement | null,
): T {
  const next: { [K in IrMapSlot]?: UvPlacement } = {};
  for (const s of MAP_UV_SLOTS) {
    const value = s === slot ? placement : mat.mapUvTransforms?.[s];
    if (value) next[s] = value;
  }
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mat)) if (k !== 'mapUvTransforms') rest[k] = v;
  return (Object.keys(next).length > 0 ? { ...rest, mapUvTransforms: next } : rest) as unknown as T;
}

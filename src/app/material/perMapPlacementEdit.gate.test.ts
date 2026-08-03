// #550 INSPECTOR SLICE — the gate for the panel's read/write rule over the per-map
// UV placement bag. Written BEFORE the module and committed RED.
//
// ── WHY THIS TIER, and not the browser ────────────────────────────────────────
//
// `NPanel.tsx` is not unit-testable (one large component), so every previous
// placement rule shipped observable ONLY through the 34-minute browser suite —
// which is how `applyGltfUvTransform`'s skip rule stayed unexamined until the render
// slice extracted it. The rule this slice adds is not JSX, it is three decisions:
//   1. WHICH slots get a row, and in what ORDER (enumerated from the IR's closed
//      table — never `Object.keys(bag)`, which enumerates from whatever happened to
//      be captured and orders rows by import accident).
//   2. What an EDIT writes (that slot's own absolute placement; nothing else moves —
//      REPLACEMENT, so a per-map slot ignores the shared value entirely).
//   3. What a RESET writes, which is the one with a silent failure mode: the slot's
//      key must be REMOVED, and when the last entry goes the FIELD ITSELF must be
//      absent. `{...mat, mapUvTransforms: undefined}` and `{...mat, mapUvTransforms:
//      {}}` both read as "no per-map placement" and both key DIFFERENTLY from a
//      material that never had one, because `materialKeyOf` walks own enumerable
//      keys. `JSON.stringify` then DROPS an `undefined`-valued key, so the live
//      object and its saved-then-reloaded twin disagree about the same material.
//      Nothing errors; the cache re-mints. See `src/nodes/types.ts:319-325`.
// So the module owns the PRESENCE of the field, and the panel cannot reintroduce it.
//
// ── THE ROAD, stated because the value does not carry it ──────────────────────
// These rows belong to the glTF material editor, whose road applies placements about
// the UV ORIGIN (KHR_texture_transform, what the import captured). The panel is a
// PASS-THROUGH: it shows and writes the road's own stored numbers with no pivot
// conversion, because a conversion here would be a third spelling of the placement
// rule that `uvPlacement.ts` already owns. The authored (centre-pivot) editor does
// NOT get per-map rows in this slice, so no per-map value is ever authored on one
// road and read by the other. See #551 for the divergence itself.
//
// REF: src/app/material/perMapPlacementEdit.ts (the subject),
//      src/app/material/uvPlacement.ts (`resolveSlotPlacement` — the READ side of the
//      same replacement rule; this module is its WRITE side),
//      src/core/import/perMapUvCapture.gate.test.ts case 6 (the censuses);
//      issues #550, #551, #217, #181.

import { describe, expect, it } from 'vitest';
import type { InlineMaterialMaps, UvPlacement } from '../../nodes/types';
import { MAP_UV_SLOTS, hydrateInlineMaterial } from '../../nodes/materialSchema';
import { MATERIAL_MAP_SLOTS } from './attachMapFromFile';
import {
  perMapPlacementRows,
  withSlotPlacement,
  type PerMapPlacementHost,
} from './perMapPlacementEdit';

const place = (t: [number, number], o: [number, number], r: number): UvPlacement => ({
  tiling: t,
  offset: o,
  rotation: r,
});

const ALBEDO = place([2, 3], [0.1, 0.2], 0);
const EMISSIVE = place([4, 4], [0.5, 0.5], 0.25);

/**
 * ⚠️ Built DIRECTLY as object literals, NOT through a shared factory or through
 * `hydrateInlineMaterial`. The render slice's null falsification landed exactly here:
 * every fixture came through a constructor that already dropped an empty bag, so the
 * gate's input space was the constructor's output space and it had been testing the
 * constructor. A public function's contract is over what ANY caller can hand it.
 */
const withBag = (bag: Record<string, UvPlacement>): PerMapPlacementHost & { name: string } => ({
  name: 'm',
  mapUvTransforms: bag as PerMapPlacementHost['mapUvTransforms'],
});

describe('#550 case 1 — rows come from the IR’s closed table, filtered to present entries', () => {
  it('lists exactly the slots that carry their own placement', () => {
    const rows = perMapPlacementRows(withBag({ emissive: EMISSIVE, albedo: ALBEDO }));
    expect(rows.map((r) => r.slot)).toEqual(['albedo', 'emissive']);
  });

  it('orders rows by the IR table, NOT by the order the bag happened to be built in', () => {
    // The bag literal below is deliberately in reverse table order. Enumerating with
    // `Object.keys(bag)` would return that order and pass a weaker assertion.
    const rows = perMapPlacementRows(withBag({ ao: ALBEDO, normal: EMISSIVE, albedo: ALBEDO }));
    expect(rows.map((r) => r.slot)).toEqual(['albedo', 'normal', 'ao']);
  });

  it('carries each slot’s own placement through unchanged (no conversion, no default)', () => {
    const rows = perMapPlacementRows(withBag({ albedo: ALBEDO, emissive: EMISSIVE }));
    expect(rows).toEqual([
      { slot: 'albedo', placement: ALBEDO },
      { slot: 'emissive', placement: EMISSIVE },
    ]);
  });

  it('FOIL — a material with no bag at all has no rows, and does not throw', () => {
    expect(perMapPlacementRows({ name: 'plain' } as PerMapPlacementHost)).toEqual([]);
  });

  it('FOIL — an empty bag has no rows (the shape a careless reset would leave)', () => {
    expect(perMapPlacementRows(withBag({}))).toEqual([]);
  });
});

describe('#550 case 2 — an edit writes that slot’s own placement and moves nothing else', () => {
  it('replaces one slot’s placement, leaving the other slots byte-identical', () => {
    const next = withSlotPlacement(
      withBag({ albedo: ALBEDO, emissive: EMISSIVE }),
      'albedo',
      place([9, 9], [0, 0], 1),
    );
    expect(next.mapUvTransforms).toEqual({
      albedo: place([9, 9], [0, 0], 1),
      emissive: EMISSIVE,
    });
  });

  it('leaves the SHARED placement untouched — replacement, never composition', () => {
    const mat = { ...withBag({ albedo: ALBEDO }), uvTransform: place([1, 1], [0, 0], 0) };
    const next = withSlotPlacement(mat, 'albedo', place([5, 5], [0, 0], 0));
    expect(next.uvTransform).toEqual(place([1, 1], [0, 0], 0));
  });

  it('adds the field when a material that had none is given a slot placement', () => {
    const next = withSlotPlacement({ name: 'plain' } as PerMapPlacementHost, 'normal', ALBEDO);
    expect(next.mapUvTransforms).toEqual({ normal: ALBEDO });
  });

  it('does not mutate the material it was given', () => {
    const mat = withBag({ albedo: ALBEDO });
    withSlotPlacement(mat, 'albedo', place([9, 9], [0, 0], 0));
    expect(mat.mapUvTransforms).toEqual({ albedo: ALBEDO });
  });

  it('preserves every other field on the material', () => {
    const mat = { ...withBag({ albedo: ALBEDO }), name: 'brick', geometry: { doubleSided: true } };
    const next = withSlotPlacement(mat, 'albedo', EMISSIVE);
    expect(next.name).toBe('brick');
    expect(next.geometry).toEqual({ doubleSided: true });
  });
});

describe('#550 case 3 — a reset removes that slot’s entry, so the slot falls back to shared', () => {
  it('drops exactly the reset slot’s key and keeps the rest', () => {
    const next = withSlotPlacement(withBag({ albedo: ALBEDO, emissive: EMISSIVE }), 'albedo', null);
    expect(next.mapUvTransforms).toEqual({ emissive: EMISSIVE });
  });

  it('leaves the reset slot with NO own key — not a key set to undefined', () => {
    const next = withSlotPlacement(withBag({ albedo: ALBEDO, emissive: EMISSIVE }), 'albedo', null);
    expect(Object.keys(next.mapUvTransforms ?? {})).toEqual(['emissive']);
  });

  it('resetting a slot that never had an entry is a no-op, not a materialised key', () => {
    const next = withSlotPlacement(withBag({ albedo: ALBEDO }), 'normal', null);
    expect(Object.keys(next.mapUvTransforms ?? {})).toEqual(['albedo']);
  });
});

describe('#550 case 4 — resetting the LAST entry removes the FIELD, not just the key', () => {
  // This is the case with no visible symptom: `mapUvTransforms: {}` renders exactly
  // like an absent field and keys differently from one. → src/nodes/types.ts:319-325.
  it('the material has no own `mapUvTransforms` key at all', () => {
    const next = withSlotPlacement(withBag({ albedo: ALBEDO }), 'albedo', null);
    expect(Object.prototype.hasOwnProperty.call(next, 'mapUvTransforms')).toBe(false);
  });

  it('keys identically to a material that never carried the field', () => {
    const reset = withSlotPlacement(withBag({ albedo: ALBEDO }), 'albedo', null);
    expect(Object.keys(reset).sort()).toEqual(['name']);
  });

  it('survives a save/load round trip identically — the two serialisers agree', () => {
    // `JSON.stringify` DROPS an undefined-valued key while `Object.keys` counts it, so
    // an `undefined`-valued field makes the live object and its reloaded twin disagree.
    const reset = withSlotPlacement(withBag({ albedo: ALBEDO }), 'albedo', null);
    expect(JSON.parse(JSON.stringify(reset))).toEqual(reset);
    expect(Object.keys(JSON.parse(JSON.stringify(reset)))).toEqual(Object.keys(reset));
  });

  it('CONTROL — while an entry remains, the field IS present (so case 4 is not vacuous)', () => {
    const next = withSlotPlacement(withBag({ albedo: ALBEDO, emissive: EMISSIVE }), 'albedo', null);
    expect(Object.prototype.hasOwnProperty.call(next, 'mapUvTransforms')).toBe(true);
  });
});

describe('#550 case 5 — the module owns the field’s PRESENCE, on inputs no constructor made', () => {
  it('an already-empty bag handed in directly is REMOVED, not passed through', () => {
    // `hydrateInlineMaterial` drops an empty bag, so no fixture built through it can
    // produce this input — which is precisely why it is built directly here.
    const next = withSlotPlacement(withBag({}), 'albedo', null);
    expect(Object.prototype.hasOwnProperty.call(next, 'mapUvTransforms')).toBe(false);
  });

  it('a bag whose only entry is undefined-valued is REMOVED too', () => {
    const mat = { name: 'm', mapUvTransforms: { albedo: undefined } } as PerMapPlacementHost;
    const next = withSlotPlacement(mat, 'normal', null);
    expect(Object.prototype.hasOwnProperty.call(next, 'mapUvTransforms')).toBe(false);
  });

  it('an undefined-valued entry is not a row', () => {
    const mat = {
      name: 'm',
      mapUvTransforms: { albedo: undefined, emissive: EMISSIVE },
    } as PerMapPlacementHost;
    expect(perMapPlacementRows(mat).map((r) => r.slot)).toEqual(['emissive']);
  });
});

describe('#550 case 6 — the panel’s slot table and the IR’s are the same table', () => {
  // The placement rows enumerate from the IR's closed table (`MAP_UV_SLOTS`, which the
  // parse road and the capture gate already walk). The Maps rows directly above them in
  // the panel enumerate from `MATERIAL_MAP_SLOTS`, a hand-written union of the same six
  // names. Two lists, one answer — so a seventh IR slot that nobody adds to the panel
  // list would give a map row no placement row, silently. Asserted BOTH ways.
  it('the same slots, in the same order', () => {
    expect([...MATERIAL_MAP_SLOTS]).toEqual([...MAP_UV_SLOTS]);
  });

  it('the IR table is exactly the map-slot keys of the IR type (arity, not just names)', () => {
    // Typed as a total Record, so a seventh `InlineMaterialMaps` slot is a COMPILE error
    // here rather than a silently-narrower list — the rung above a runtime assertion.
    const asKeys: Record<keyof InlineMaterialMaps, true> = {
      albedo: true,
      normal: true,
      roughness: true,
      metalness: true,
      emissive: true,
      ao: true,
    };
    expect([...MAP_UV_SLOTS].sort()).toEqual(Object.keys(asKeys).sort());
  });
});

describe('#550 case 7 — the EDIT road and the PARSE road agree on what "no per-map" is', () => {
  // Two writers decide the field's presence: `hydrateInlineMaterial` (parse) and
  // `withSlotPlacement` (edit). Neither can be derived from the other without
  // restructuring a live parse road, so the agreement is PINNED here instead: the
  // failure mode is one of them starting to emit `{}` while the other omits, which
  // nothing else would notice because the two materials render identically.
  it('the parse road leaves no own key for an empty bag', () => {
    const parsed = hydrateInlineMaterial({ mapUvTransforms: {} });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'mapUvTransforms')).toBe(false);
  });

  it('the edit road agrees, on a material the parse road produced', () => {
    const parsed = hydrateInlineMaterial({ mapUvTransforms: { albedo: ALBEDO } });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'mapUvTransforms')).toBe(true);
    const reset = withSlotPlacement(parsed, 'albedo', null);
    expect(Object.prototype.hasOwnProperty.call(reset, 'mapUvTransforms')).toBe(false);
  });
});

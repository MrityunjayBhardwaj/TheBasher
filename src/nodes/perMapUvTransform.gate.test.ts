// #550 — the per-map UV placement gate.
//
// The slice's whole risk is INVISIBLE IN REVIEW, which is why this is a gate rather
// than a comment. Adding a per-map field can go wrong in four ways that all typecheck,
// all render correctly on the day they ship, and none of which any existing test sees:
//
//   1. the field is materialised (`{}` or `undefined`) rather than absent, so every
//      existing material's content key changes and the whole cache re-mints on the
//      first load after the version bump — a cold start and no visible symptom;
//   2. one of the TWO parse roads drops it (zod strips unknown keys; the hand-written
//      `hydrateInlineMaterial` simply would not copy it), so a saved placement is
//      silently lost on reload;
//   3. the field is excluded from the content key — the tempting "fix" for (1) — which
//      makes two materials that render DIFFERENTLY share one instance, reopening the
//      exact repaint bug the identity work exists to close;
//   4. a seventh map slot is added to the IR and quietly has no per-map placement.
//
// Each numbered case below is one of those. The pairing discipline from
// `materialKey.test.ts` applies: every "keys the same" assertion is paired with a
// "keys differently" one over the same fixture, because sameness alone is satisfied by
// a constant key and difference alone by a key that never dedups.

import { describe, expect, it } from 'vitest';
import {
  hydrateInlineMaterial,
  openpbrMaterialSchema,
  MAP_UV_SLOTS,
  NULL_MAPS,
} from './materialSchema';
import { materialKeyOf } from './materialKey';
import type { InlineMaterialSpec } from './types';

/** A material as an EXISTING saved project holds it — no per-map field at all. */
const legacyRaw = { name: 'm', base: { color: '#ff0000' } };

const placement = (tiling: [number, number]) => ({ tiling, offset: [0, 0], rotation: 0 });

describe('#550 case 1 — an unused per-map field must be ABSENT, not empty (migration safety)', () => {
  it('hydrating a pre-#550 material emits NO mapUvTransforms key', () => {
    const out = hydrateInlineMaterial(legacyRaw);
    expect(Object.prototype.hasOwnProperty.call(out, 'mapUvTransforms')).toBe(false);
    expect(Object.keys(out)).not.toContain('mapUvTransforms');
  });

  it('and therefore keys IDENTICALLY to the same material hydrated before the field existed', () => {
    // The pre-#550 key, reconstructed by deleting the field from a hydrate result.
    const now = hydrateInlineMaterial(legacyRaw) as Record<string, unknown>;
    const before = { ...now };
    delete before.mapUvTransforms;
    expect(materialKeyOf(now)).toBe(materialKeyOf(before));
  });

  it('the zod schema likewise omits the key when the input has none', () => {
    const parsed = openpbrMaterialSchema().parse({}) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, 'mapUvTransforms')).toBe(false);
  });

  it('CONTROL — a materialised empty bag really would key differently (so this is not vacuous)', () => {
    const base = hydrateInlineMaterial(legacyRaw);
    expect(materialKeyOf({ ...base, mapUvTransforms: {} })).not.toBe(materialKeyOf(base));
    expect(materialKeyOf({ ...base, mapUvTransforms: undefined })).not.toBe(materialKeyOf(base));
  });

  it('an empty bag on INPUT still hydrates to an absent field', () => {
    const out = hydrateInlineMaterial({ ...legacyRaw, mapUvTransforms: {} });
    expect(Object.prototype.hasOwnProperty.call(out, 'mapUvTransforms')).toBe(false);
  });
});

describe('#550 case 2 — BOTH parse roads must carry a real per-map placement', () => {
  const raw = { ...legacyRaw, mapUvTransforms: { normal: placement([4, 4]) } };

  it('the hand-written hydrator keeps it', () => {
    const out = hydrateInlineMaterial(raw);
    expect(out.mapUvTransforms?.normal?.tiling).toEqual([4, 4]);
  });

  it('the zod schema keeps it (an undeclared field would be STRIPPED, silently)', () => {
    const parsed = openpbrMaterialSchema().parse(raw) as InlineMaterialSpec;
    expect(parsed.mapUvTransforms?.normal?.tiling).toEqual([4, 4]);
  });

  it('a slot not listed stays absent — replacement semantics, not a defaulted delta', () => {
    const out = hydrateInlineMaterial(raw);
    expect(out.mapUvTransforms?.albedo).toBeUndefined();
    expect(Object.keys(out.mapUvTransforms ?? {})).toEqual(['normal']);
  });

  it('inner components still default inside a PRESENT slot (the house rule, where it applies)', () => {
    const out = hydrateInlineMaterial({
      ...legacyRaw,
      mapUvTransforms: { albedo: { tiling: [2, 2] } },
    });
    expect(out.mapUvTransforms?.albedo).toEqual({ tiling: [2, 2], offset: [0, 0], rotation: 0 });
  });
});

describe('#550 case 3 — per-map placement MUST reach the content key', () => {
  const base = hydrateInlineMaterial(legacyRaw);

  it('two materials differing ONLY in one slot placement key differently', () => {
    const a = { ...base, mapUvTransforms: { albedo: placement([2, 2]) } };
    const b = { ...base, mapUvTransforms: { albedo: placement([3, 3]) } };
    expect(materialKeyOf(a)).not.toBe(materialKeyOf(b));
  });

  it('the same placement on a DIFFERENT slot is also a different key', () => {
    const a = { ...base, mapUvTransforms: { albedo: placement([2, 2]) } };
    const b = { ...base, mapUvTransforms: { normal: placement([2, 2]) } };
    expect(materialKeyOf(a)).not.toBe(materialKeyOf(b));
  });

  it('PAIRED — two materials with the SAME per-map placement share one key', () => {
    const a = { ...base, mapUvTransforms: { albedo: placement([2, 2]) } };
    const b = { ...base, mapUvTransforms: { albedo: placement([2, 2]) } };
    expect(materialKeyOf(a)).toBe(materialKeyOf(b));
  });
});

describe('#550 case 4 — the per-map slot list is DERIVED from the IR map slots', () => {
  it('equal in both directions, so a seventh map slot cannot miss per-map placement', () => {
    expect([...MAP_UV_SLOTS].sort()).toEqual([...Object.keys(NULL_MAPS)].sort());
  });

  // BOTH roads, every slot. Covering only ONE road here was a real blind spot, and it
  // was measured rather than reasoned: deleting `ao` from the zod per-slot schema left
  // this file 14/14 GREEN, because the loop below ran the hand-written hydrator and the
  // only zod assertion in the file happened to use `normal`. A per-road × per-slot
  // matrix is the smallest thing that cannot be fooled by which slot a test picked.
  it('every slot round-trips a placement on BOTH parse roads', () => {
    for (const slot of MAP_UV_SLOTS) {
      const raw = { ...legacyRaw, mapUvTransforms: { [slot]: placement([5, 5]) } };

      const hydrated = hydrateInlineMaterial(raw);
      expect(hydrated.mapUvTransforms?.[slot]?.tiling, `hydrator, slot ${slot}`).toEqual([5, 5]);

      const parsed = openpbrMaterialSchema().parse(raw) as InlineMaterialSpec;
      expect(parsed.mapUvTransforms?.[slot]?.tiling, `zod, slot ${slot}`).toEqual([5, 5]);
    }
  });
});

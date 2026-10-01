// #1123 — the normal and occlusion map strengths are an OPTIONAL bag, absent at the default of 1.
//
// `materialKeyOf` walks every own key, so a bag the schema or the hydrate filled in would give every
// saved material a new identity on its first load after this change: a cold cache with nothing on
// screen to show for it. So a material saved before the field existed must come back WITHOUT it,
// on both parse roads, and must key exactly as it did. The control proves the key would notice.
//
// REF: src/nodes/materialSchema.ts (`mapStrengthsSchema`, `hydrateMapStrengths`);
//      src/app/material/openpbrToThree.ts (the compile omits both at the default);
//      src/nodes/perMapUvTransform.gate.test.ts (the same rule for per-map placement).

import { describe, expect, it } from 'vitest';
import { hydrateInlineMaterial, openpbrMaterialSchema } from './materialSchema';
import { materialKeyOf } from './materialKey';
import { openpbrToThree } from '../app/material/openpbrToThree';

/** A material as an existing saved project holds it: no strength field at all. */
const legacyRaw = { name: 'm', base: { color: '#ff0000' } };

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

describe('#1123 — a material saved before the strengths keeps its identity', () => {
  it('hydrating it emits no mapStrengths key, and it keys as it did', () => {
    const now = hydrateInlineMaterial(legacyRaw) as unknown as Record<string, unknown>;
    expect(has(now, 'mapStrengths')).toBe(false);
    const before = { ...now };
    delete before.mapStrengths;
    expect(materialKeyOf(now)).toBe(materialKeyOf(before));
  });

  it('the zod schema omits it too', () => {
    expect(has(openpbrMaterialSchema().parse({}) as object, 'mapStrengths')).toBe(false);
  });

  it('CONTROL — a materialised bag would key differently, so the rows above can fail', () => {
    const base = hydrateInlineMaterial(legacyRaw);
    expect(materialKeyOf({ ...base, mapStrengths: {} })).not.toBe(materialKeyOf(base));
  });

  it('an empty bag, or one holding no number, hydrates to absent', () => {
    expect(has(hydrateInlineMaterial({ ...legacyRaw, mapStrengths: {} }), 'mapStrengths')).toBe(
      false,
    );
    const junk = hydrateInlineMaterial({ ...legacyRaw, mapStrengths: { normal: 'x', ao: NaN } });
    expect(has(junk, 'mapStrengths')).toBe(false);
  });

  it('the compile omits both three fields for it', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial(legacyRaw));
    expect(has(drawn, 'normalScale')).toBe(false);
    expect(has(drawn, 'aoMapIntensity')).toBe(false);
  });
});

describe('#1123 — a real strength survives both parse roads and reaches the compile', () => {
  const raw = { ...legacyRaw, mapStrengths: { normal: 0.5, ao: 0.3 } };

  it('the hand-written hydrate keeps it', () => {
    expect(hydrateInlineMaterial(raw).mapStrengths).toEqual({ normal: 0.5, ao: 0.3 });
  });

  it('the zod schema keeps it (an undeclared field would be stripped without a word)', () => {
    const parsed = openpbrMaterialSchema().parse(raw) as { mapStrengths?: unknown };
    expect(parsed.mapStrengths).toEqual({ normal: 0.5, ao: 0.3 });
  });

  it('one slot set leaves the other absent, which reads as 1', () => {
    expect(hydrateInlineMaterial({ ...legacyRaw, mapStrengths: { ao: 0.3 } }).mapStrengths).toEqual(
      { ao: 0.3 },
    );
  });

  it('the compile hands three its field names', () => {
    const drawn = openpbrToThree(hydrateInlineMaterial(raw));
    expect(drawn).toMatchObject({ normalScale: 0.5, aoMapIntensity: 0.3 });
  });

  it('two materials differing only in a strength key differently', () => {
    const a = hydrateInlineMaterial({ ...legacyRaw, mapStrengths: { normal: 0.5 } });
    const b = hydrateInlineMaterial({ ...legacyRaw, mapStrengths: { normal: 0.6 } });
    expect(materialKeyOf(a)).not.toBe(materialKeyOf(b));
  });
});

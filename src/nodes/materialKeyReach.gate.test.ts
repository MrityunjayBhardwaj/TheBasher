// #542 — how far render identity actually REACHES, machine-checked.
//
// ── WHY THIS GATE EXISTS ───────────────────────────────────────────────────────────────
//
// The invariant is stated over the whole value union: "identity is minted by graph
// evaluation, never rediscovered downstream" (docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4).
// It is ENFORCED on one member of that union. `materialKey` exists on `MeshDataValue` and
// nowhere else, minted at exactly two producers, while two other members carry a material
// with no key at all.
//
// That gap is not a bug today — §4's "How far this reaches" paragraph explains why each
// unkeyed road is safe — but the explanation is prose about a measurable set, and prose
// about a measurable set goes stale silently. A third minting producer, a fourth kind that
// starts carrying a material, or a second downstream re-derivation of the key would each
// falsify a sentence in that paragraph while every test stayed green.
//
// So the paragraph's three load-bearing counts are pinned here. This gate does not argue
// that the reach SHOULD be wider — that question is #542's stronger half and needs a design
// answer for pass-through producers. It only makes the reach impossible to misstate.
//
// ── THREE QUESTIONS, THREE KEYS ────────────────────────────────────────────────────────
//
// Each case names which question it answers, because they fail independently:
//
//   A. WHO MINTS IT?          — keyed on a write to the field (`materialKey:`).
//   B. WHO COULD CARRY ONE?   — keyed on the type declarations, so "1 of 6" is DERIVED
//                               from the union rather than copied out of it.
//   C. WHO RE-DERIVES IT?     — keyed on importers of `materialKeyOf`, which is what makes
//                               an unkeyed road safe rather than merely unkeyed.
//
// ⚠️ WHAT THIS CANNOT SEE, stated here rather than discovered later. Case C pins the set of
// modules that reach for the key FUNCTION; it cannot notice a second SPELLING of the same
// idea — a module that hashes an IR its own way computes a rival identity while importing
// nothing from here. Nothing does that today (the registry's own `keyOf` was retired into
// this function by #536 S2), and no static key over this vocabulary would find it. That
// residual belongs with #535's behavioural backstop.
//
// REF: docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4 (the invariant and the reach paragraph
//      this gate keeps honest); src/nodes/materialKey.ts (`materialKeyOf`);
//      src/nodes/types.ts (the union and the one member carrying a key);
//      src/app/material/primitiveMaterialInputs.ts (the downstream fallback);
//      src/app/registryDoors.gate.test.ts (the sibling gate this shape comes from);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #536, #537, #542.

import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../tools/gates/sourceFiles';
import { stripComments } from '../test-utils/sourceScan';

/**
 * The body of `export interface <name> { … }`, comment-stripped.
 *
 * Comments come off first and deliberately: `MeshDataValue.materialKey` is documented at
 * length, and a doc comment naming a field reads exactly like a declaration of it. A
 * name-keyed census that cannot tell a use from a mention taxes documentation, and the
 * cheapest way to make it green is to delete the explanation.
 */
export function interfaceBody(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const head = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(stripped);
  if (!head) return null;
  // Brace-matched rather than "up to the next `}` at column 0". The lazy form was written
  // first and its own control caught it: it depends on the closing brace being unindented,
  // and it would end the body EARLY at the first nested `}` — so a field declared with an
  // inline object type would hide every field after it from the census, silently.
  let depth = 1;
  let i = head.index + head[0].length;
  const start = i;
  for (; i < stripped.length && depth > 0; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
  }
  return depth === 0 ? stripped.slice(start, i - 1) : null;
}

/** Does that interface DECLARE `field` (as opposed to mentioning it)? */
export function declaresField(body: string, field: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*(?:readonly\\s+)?${field}\\??\\s*:`).test(body);
}

/** The member names of `export type <name> = A | B | …`, in declaration order. */
export function unionMembers(src: string, name: string): string[] {
  const m = new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`).exec(stripComments(src));
  if (!m) return [];
  return m[1]
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Every module that WRITES the `materialKey` field, and what it is doing there.
 *
 * Keyed on the field being given a value or a type — `materialKey:` not preceded by a dot,
 * so a READ (`data?.materialKey`) is deliberately excluded. Reads are not the reach; a
 * consumer reading a key it was handed says nothing about which kinds carry one.
 *
 * A third minter is not forbidden. It is a RED that forces whoever adds it to update §4's
 * reach paragraph in the same commit, which is the entire point of this file.
 */
const MATERIAL_KEY_WRITERS: Record<string, string> = {
  'src/nodes/types.ts': 'declares it — on MeshDataValue, and on no other union member',
  'src/nodes/BoxData.ts': 'mints it after the fold',
  'src/nodes/SphereData.ts': 'mints it after the fold',
};

/**
 * Every module that reaches for the key FUNCTION.
 *
 * This is the case that pins the safety argument for the unkeyed roads. `ModifiedData`
 * shares the material registry exactly as `MeshData` does, and it carries no minted key —
 * what keeps the two roads agreeing is that the renderer's fallback calls the SAME function
 * the evaluator called, over the same IR. One function, one answer. A fourth importer means
 * a second place deciding identity, which is the failure this whole epic is about.
 */
const KEY_FUNCTION_CONSUMERS: Record<string, string> = {
  'src/nodes/BoxData.ts': 'mints — the evaluator side',
  'src/nodes/SphereData.ts': 'mints — the evaluator side',
  'src/app/material/primitiveMaterialInputs.ts':
    'the documented fallback: re-derives when the value carries no minted key',
};

describe('#542 — the reach of render identity, so §4 cannot overstate it', () => {
  it('mints the material key at exactly two producers, on one declaring type', () => {
    const writers = sourceFiles()
      .filter(([, src]) => /(?<![\w.])materialKey\s*\??\s*:/.test(stripComments(src)))
      .map(([path]) => path)
      .sort();

    expect(writers).toEqual(Object.keys(MATERIAL_KEY_WRITERS).sort());
  });

  it('carries that key on 1 of the 6 ObjectData kinds, and a material on 3', () => {
    // DERIVED from the union rather than restated: "1 of 6" is a claim about the type, so
    // read the type. A seventh kind joining the union changes the denominator here without
    // anyone remembering that a paragraph in the design doc counts it.
    const types = sourceFiles().find(([path]) => path === 'src/nodes/types.ts')?.[1] ?? '';
    const members = unionMembers(types, 'ObjectData');

    expect(members).toEqual([
      'MeshDataValue',
      'CurveDataValue',
      'LightDataValue',
      'CameraDataValue',
      'BakedDataValue',
      'ModifiedDataValue',
    ]);

    const bodies = members.map((name) => [name, interfaceBody(types, name)] as const);
    expect(bodies.filter(([, body]) => body === null).map(([name]) => name)).toEqual([]);

    const carriesMaterial = bodies
      .filter(([, body]) => declaresField(body as string, 'material'))
      .map(([name]) => name);
    const carriesKey = bodies
      .filter(([, body]) => declaresField(body as string, 'materialKey'))
      .map(([name]) => name);

    // The gap #542 exists to write down: two kinds hold a material with no minted identity.
    expect(carriesMaterial).toEqual(['MeshDataValue', 'BakedDataValue', 'ModifiedDataValue']);
    expect(carriesKey).toEqual(['MeshDataValue']);
  });

  it('re-derives the key in exactly one downstream place, through the same function', () => {
    const consumers = sourceFiles()
      .filter(([, src]) => /\bmaterialKeyOf\b/.test(stripComments(src)))
      .map(([path]) => path)
      .filter((path) => path !== 'src/nodes/materialKey.ts') // where it is defined
      .sort();

    expect(consumers).toEqual(Object.keys(KEY_FUNCTION_CONSUMERS).sort());
  });

  it('guards the guard — the parsers read declarations, not prose about them', () => {
    // Without these the cases above would report a clean sweep forever if a regex went
    // stale, and the prose control is not hypothetical: this repo has already had an exact
    // census red on an untouched tree because it counted a doc comment.
    const sample = `
      /** Carries a materialKey one day, maybe. Mentions material: too. */
      export interface FakeValue {
        readonly kind: 'Fake';
        // materialKey: 'not a declaration';
        readonly material: InlineMaterialSpec | null;
      }
    `;
    const body = interfaceBody(sample, 'FakeValue') as string;
    expect(body).not.toBeNull();
    expect(declaresField(body, 'material')).toBe(true);
    expect(declaresField(body, 'materialKey')).toBe(false);
    expect(declaresField(body, 'kind')).toBe(true);

    // A nested block must not end the body early — the defect the first parser had, found
    // by this control rather than by reasoning about it. `material` sits AFTER the nested
    // brace, so a lazy match returns a body that looks perfectly well-formed and is short.
    const nested = `export interface NestedValue {\n  readonly opts: { a: string };\n  readonly material: X;\n}\n`;
    expect(declaresField(interfaceBody(nested, 'NestedValue') as string, 'material')).toBe(true);

    // An optional field is still a declaration; a read is still not a write.
    expect(declaresField(`  readonly materialKey?: string;`, 'materialKey')).toBe(true);
    const writes = (src: string) => /(?<![\w.])materialKey\s*\??\s*:/.test(stripComments(src));
    expect(writes(`materialKey: materialKeyOf(material),`)).toBe(true);
    expect(writes(`mat ? data?.materialKey : null,`)).toBe(false);
    expect(writes(`// materialKey: is documented here`)).toBe(false);

    expect(unionMembers(`export type Two = Alpha | Beta;`, 'Two')).toEqual(['Alpha', 'Beta']);
    expect(unionMembers(`export type Two = Alpha | Beta;`, 'Missing')).toEqual([]);
  });
});

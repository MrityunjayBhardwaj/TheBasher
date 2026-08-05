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
// ── FOUR QUESTIONS, FOUR KEYS ──────────────────────────────────────────────────────────
//
// Each case names which question it answers, because they fail independently:
//
//   A. WHO MINTS IT?          — keyed on a write to the field (`materialKey:`).
//   B. WHO COULD CARRY ONE?   — keyed on the type declarations, so "1 of 6" is DERIVED
//                               from the union rather than copied out of it.
//   C. WHO RE-DERIVES IT?     — keyed on importers of `materialKeyOf`, which is what makes
//                               an unkeyed road safe rather than merely unkeyed.
//   D. WHO ATTACHES WITHOUT   — keyed on the arguments at the seam's call sites (#545).
//      ONE?                     A, B and C all watch the key itself; only D watches who
//                               joins the shared registry while having none, which is the
//                               condition §4's safety argument actually depends on.
//
// ⚠️ WHAT THIS CANNOT SEE, stated here rather than discovered later. Case C pins the set of
// modules that reach for the key FUNCTION; it cannot notice a second SPELLING of the same
// idea — a module that hashes an IR its own way computes a rival identity while importing
// nothing from here. Nothing does that today (the registry's own `keyOf` was retired into
// this function by #536 S2), and no static key over this vocabulary would find it. That
// residual belongs with #535's behavioural backstop.
//
// Case D has the same shape of residual, and it is worth stating exactly, because most of
// what looks like an evasion is not one. MEASURED by perturbing the real call sites:
//
//   • a third call site added anywhere reds the parse count whatever it passes (3 ≠ 2);
//   • the UNKEYED site's `null` re-spelled as a variable reds the unkeyed count (0 ≠ 1).
//
// TWO evasions stay silent, both measured green:
//
//   • a call made through a RENAMED import — `import { usePrimitiveMaterial as attach }`
//     — is not seen at all, because the census keys on the callee's spelling;
//   • the KEYED site's argument re-spelled as a variable that always resolves to null.
//     The census reads argument TEXT, so that road reports as keyed while attaching with
//     no identity. Observed: every assertion here stayed green under exactly that edit.
//
// Both are the SAME residual case C names — a static census sees spellings, not values —
// and neither is closable by a wider regex. The behavioural backstop is #535's, and the
// import side is `registryDoors.gate.test.ts`, which pins this module as the registry's
// only attach consumer, so an aliased caller would still have to come through here.
//
// REF: docs/RENDER-RESOURCE-IDENTITY-DESIGN.md §4 (the invariant and the reach paragraph
//      this gate keeps honest); src/nodes/materialKey.ts (`materialKeyOf`);
//      src/nodes/types.ts (the union and the one member carrying a key);
//      src/app/material/primitiveMaterialInputs.ts (the downstream fallback);
//      src/app/registryDoors.gate.test.ts (the sibling gate this shape comes from);
//      src/app/material/usePrimitiveMaterial.ts (the attach seam case D counts, and where
//      the required-parameter argument is written out);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #536, #537, #542, #545.

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

/**
 * The argument lists of every CALL to `fn`, one array of source-text arguments per call.
 *
 * Bracket-matched rather than comma-split, and the difference is load-bearing rather than
 * fastidious: the keyed call site passes `mat ? (data?.materialKey ?? null) : null`, which
 * a comma split reports as three arguments — and its last one is the bare text `null`,
 * so the naive parser would count the KEYED road as unkeyed and the census would be exactly
 * inverted while looking perfectly green.
 *
 * The definition is excluded by the `function` lookbehind, since `export function fn(` is
 * otherwise indistinguishable from a call and would be counted as one forever.
 */
export function callArgsOf(src: string, fn: string): string[][] {
  const stripped = stripComments(src);
  const out: string[][] = [];
  for (const m of stripped.matchAll(new RegExp(`(?<!function\\s)\\b${fn}\\s*\\(`, 'g'))) {
    const open = (m.index as number) + m[0].length;
    const args: string[] = [];
    let depth = 1;
    let start = open;
    for (let i = open; i < stripped.length && depth > 0; i++) {
      const c = stripped[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) args.push(stripped.slice(start, i));
      } else if (c === ',' && depth === 1) {
        args.push(stripped.slice(start, i));
        start = i + 1;
      }
    }
    if (depth !== 0) continue; // unbalanced — do not guess
    const trimmed = args.map((a) => a.trim());
    // A trailing comma leaves an empty final slot; it is punctuation, not an argument.
    if (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
    out.push(trimmed);
  }
  return out;
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

  // ── D. WHO ATTACHES WITHOUT A MINTED KEY? (#545) ─────────────────────────────────────
  //
  // The fourth question, and the one the other three cannot answer. A, B and C are all
  // about who MINTS, CARRIES or RE-DERIVES the key. This one is about who joins the shared
  // registry while having none — #545's third reopen condition, "a second unkeyed road
  // starts sharing the registry", which is the condition that turns the documented fallback
  // from sufficient into wrong.
  //
  // #545's answer is that `ModifiedData` should NOT mint: the fallback calls the evaluator's
  // own function over the evaluator's own IR, so there is no second spelling to drift. That
  // answer is only safe while the unkeyed set stays at ONE, and nothing was watching it.
  //
  // Making the seam's parameter required (rather than optional) is what gives this case
  // something to count. While it was optional, a new road joined by writing nothing at all,
  // and `irKeyFor(ir, undefined)` equals `materialKeyOf(ir)` — the same value a correct
  // minted key produces — so the new road was EQUAL BY CONSTRUCTION to a correct one and no
  // behavioural test at any tier could red on it. The signature was the only tier where the
  // claim could live; this case is what makes the claim checkable once it lives there.
  //
  // Counted EXACTLY, not floored, for the reason the sibling censuses give: a floor guards
  // against the set emptying, and the failure here is the set GROWING one quiet caller at a
  // time until "the unkeyed road" is most of them.
  const UNKEYED_ATTACH_CALLERS: Record<string, string> = {
    'src/viewport/SceneFromDAG.tsx':
      'ModifiedMeshR — ModifiedDataValue mints no materialKey, and #545 measured the ' +
      'downstream fallback as the right permanent answer for it rather than as a gap',
  };

  it('attaches to the shared registry without a minted key in exactly one place', () => {
    const calls = sourceFiles().flatMap(([path, src]) =>
      callArgsOf(src, 'usePrimitiveMaterial').map((args) => ({ path, args })),
    );

    // Anti-vacuity, and it is not theoretical: a parser that found nothing would make every
    // assertion below green while counting an empty set.
    expect(
      calls.length,
      'the call-site parse does not read the two known calls — under-reading makes every ' +
        'assertion below vacuous, and over-reading means a third road now attaches here',
    ).toBe(2);

    // The type system already refuses an omitted argument. This re-checks it structurally,
    // because the way this gate dies is someone widening the parameter back to optional to
    // silence a red — at which point typecheck goes quiet and only this case still speaks.
    expect(
      calls.filter((c) => c.args.length !== 4).map((c) => c.path),
      'a caller does not pass exactly four arguments — an omitted minted key is exactly ' +
        'what #545 closed, and a fifth argument means the parser mis-split this call',
    ).toEqual([]);

    const unkeyed = calls.filter((c) => c.args[3] === 'null');
    expect(
      unkeyed.length,
      'a second road now attaches with no minted key — #545 reopen condition 3. The ' +
        'fallback is only safe while this set has one member; decide, do not drift',
    ).toBe(1);
    expect([...new Set(unkeyed.map((c) => c.path))]).toEqual(Object.keys(UNKEYED_ATTACH_CALLERS));
  });

  it('guards case D — the call parser reads arguments, not prose or definitions', () => {
    // The definition must not be counted as a call: it is written `function name(` and
    // would otherwise make the census report one caller too many, forever.
    expect(callArgsOf(`export function f(a: string, b: number) {}`, 'f')).toEqual([]);
    expect(callArgsOf(`// f(a, b, c, null) in a comment`, 'f')).toEqual([]);

    // Nested parens, ternaries and object args must not split the argument list — the
    // 4th argument at the real call site is `mat ? (data?.materialKey ?? null) : null`,
    // which a naive comma split reports as three arguments and reads as unkeyed.
    expect(callArgsOf(`f(ir, o, s, mat ? (d?.k ?? null) : null);`, 'f')).toEqual([
      ['ir', 'o', 's', 'mat ? (d?.k ?? null) : null'],
    ]);
    expect(callArgsOf(`f({ a: 1, b: 2 }, null);`, 'f')).toEqual([['{ a: 1, b: 2 }', 'null']]);

    // A trailing comma is not a fifth argument, and a 3-argument call is still 3.
    expect(callArgsOf(`f(\n  a,\n  b,\n  c,\n  null,\n);`, 'f')).toEqual([['a', 'b', 'c', 'null']]);
    expect(callArgsOf(`f(a, b, c);`, 'f')).toEqual([['a', 'b', 'c']]);
  });
});

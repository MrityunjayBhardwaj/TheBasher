// #537 — the correspondence the handle rebuild rests on, machine-checked.
//
// ── THE ASSUMPTION, AND WHY IT NEEDS A GATE ────────────────────────────────────────────
//
// The repair folds written params into a geometry descriptor and re-mints the handle. It
// finds WHICH fields to fold by asking the descriptor for its own field names
// (`descriptorParamFields`) and matching them against the paths the overlay wrote — i.e. it
// relies on a descriptor field being named exactly like the param that feeds it. Measured
// true today: `size`; `radius`/`widthSegments`/`heightSegments`; `count`/`offset`;
// `axis`/`offset`.
//
// That correspondence is a fact about two files that do not import each other, which is
// precisely the kind of fact that stops being true quietly. Rename `size` to `dimensions` on
// `BoxData` and nothing breaks, nothing errors — the descriptor keeps a field no param can
// reach, and an animated size silently returns to freezing. That is the ORIGINAL bug coming
// back through a rename, with every test green. Hence this file.
//
// ── FOUR QUESTIONS, ANSWERED SEPARATELY ────────────────────────────────────────────────
//
//   1. Is every descriptor kind CLASSIFIED — param-fed, and by which producer?
//   2. Can every descriptor field be REACHED by a param of that name on that producer?
//   3. Does folding a field actually MOVE the key (i.e. is the field really built from)?
//   4. Are the non-param-fed kinds left strictly alone?
//   5. Does the HANDLE still say the kind only once? (ns-2 D8 — added below)
//
// Question 3 is the one that catches a half-written rebuild arm. 2 alone would pass against
// an implementation that read the right names and ignored them.
//
// 🔴 QUESTION 5 EXISTS BECAUSE THE PLAN NAMED A DETECTOR THAT DOES NOT DETECT. ns-2 step 8
// was written expecting that re-adding `GeometryRef`'s hand-written `kind` would red the
// union parse in question 1. Measured: that parse walks from `export type GeometryDescriptor
// =` to the first top-level `;`, and `GeometryRef` is a separate declaration BELOW it, so
// the parse never sees the interface at all — it passed 6/6 with the field present and 6/6
// with it removed, which is a census arithmetically incapable of deciding the change it was
// cited for. Question 5 parses the INTERFACE, and its pre/post values are recorded in it.
//
// REF: src/app/modifierGeometry.ts (`descriptorParamFields`, `rebuildGeometryRef`);
//      src/app/overlayWithIdentity.ts (the seam that uses them);
//      src/nodes/types.ts (`GeometryDescriptor` — the union this censuses);
//      tools/gates/sourceFiles.ts (the shared enumeration); issues #536, #537.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  arrayGeometryRef,
  boxGeometryRef,
  descriptorParamFields,
  mirrorGeometryRef,
  subsetGeometryRef,
  rebuildGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { declaredParamKeys } from './inspectorSectionBody';
import { __resetRegistryForTests } from '../core/dag/registry';
import { registerAllNodes } from '../nodes/registerAll';
import { stripComments } from '../test-utils/sourceScan';
import type { GeometryRef } from '../nodes/types';

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

const SOURCE = join(__dirname, '../nodes/types.ts');

/**
 * Every kind of geometry handle, with the node that produces it and a representative ref
 * built by the SAME builder the evaluator uses.
 *
 * `producer: null` means the kind is not fed by any node's params — its identity comes from
 * somewhere the overlay cannot write (an asset reference, a content hash of bytes in OPFS),
 * so there is nothing here for an animated channel to invalidate.
 */
const HANDLE_KINDS: Record<
  string,
  { readonly producer: string | null; readonly ref: GeometryRef; readonly probe: unknown }
> = {
  box: { producer: 'BoxData', ref: boxGeometryRef([1, 1, 1], null), probe: [2, 2, 2] },
  sphere: { producer: 'SphereData', ref: sphereGeometryRef(1, 16, 12, null), probe: 7 },
  array: {
    producer: 'ArrayModifier',
    // 🔴 SCOPED ON PURPOSE (ns-2 step 13a), and this is the successor a fuse in
    // `scopedGeneratorBuild.gate.test.ts` named by hand. `scope` is an OPTIONAL descriptor
    // field, so an UNSCOPED fixture omits it and `descriptorParamFields` never mentions it
    // — this whole file would then be blind to the one field that arrived after it was
    // written, and blind SILENTLY, since a field nobody enumerates cannot be reported
    // unreachable. The fixture carries a scope so the two checks below actually ask about
    // it: that `ArrayModifier` declares a same-named param, and that folding a different
    // query MOVES the key.
    ref: arrayGeometryRef(boxGeometryRef([1, 1, 1], null), 2, [2, 0, 0], '0-5'),
    probe: 9,
  },
  mirror: {
    producer: 'MirrorModifier',
    // 🔴 SCOPED ON PURPOSE (ns-2 step 13b), for the reason the `array` entry above states,
    // and in the SAME COMMIT that declares `MirrorModifier.scope` — because a fuse in
    // `scopedGeneratorBuild.gate.test.ts` named that pairing by hand as its successor. Until
    // this step the fixture had to stay unscoped: a scoped mirror would have redded the
    // reach check correctly, since the param it names did not exist. Now both generators
    // carry the field, so the name-correspondence is checked for both of them.
    ref: mirrorGeometryRef(boxGeometryRef([1, 1, 1], null), 'x', 0, '0-5'),
    probe: 3,
  },
  subset: {
    producer: 'MaskModifier',
    // 🔴 SCOPED BY CONSTRUCTION (#668/#671), where the two generators above had to be scoped
    // ON PURPOSE. Their `scope` is optional, so an unscoped fixture would omit the field and
    // leave this file blind to it. A subset's scope is REQUIRED — `subsetGeometryRef` refuses
    // a blank one — so there is no unscoped fixture to accidentally write, and the field is
    // enumerated whether or not anyone remembered to think about it.
    ref: subsetGeometryRef(boxGeometryRef([1, 1, 1], null), '0-5', true),
    // `keep` is the only non-`scope` field, and the probe must MOVE the key: the two
    // polarities over one query are two different geometries.
    probe: false,
  },
  gltf: {
    producer: null,
    ref: {
      key: 'gltf|a|b',
      descriptor: { kind: 'gltf', assetRef: 'a', childName: 'b' },
    },
    probe: 'z',
  },
  baked: {
    producer: null,
    ref: {
      key: 'baked|h',
      descriptor: { kind: 'baked', hash: 'h', vertexCount: 3 },
    },
    probe: 'z',
  },
};

/** A value of the right SHAPE for `field`, so a fold is not rejected for being the wrong type. */
function probeFor(field: string, kind: string): unknown {
  const p = HANDLE_KINDS[kind].probe;
  if (field === 'offset') return kind === 'array' ? [5, 0, 0] : 5;
  if (field === 'axis') return 'y';
  if (field === 'size') return [2, 2, 2];
  // ns-2 step 13a — a DIFFERENT well-formed query, and different after canonicalisation
  // rather than merely as typed: the key folds the canonical form, so a probe that
  // canonicalised back to the fixture's `0-5` would report the field ignored when it is
  // honoured exactly right.
  if (field === 'scope') return '0-3';
  return p;
}

describe('#537 — every param that feeds a geometry handle can reach it', () => {
  it('classifies every kind in the GeometryDescriptor union', () => {
    // Read off the type rather than restated, so a seventh descriptor kind cannot be added
    // without someone answering here whether params feed it — which is exactly the question
    // whose wrong default (silently: no) is this issue.
    const src = stripComments(readFileSync(SOURCE, 'utf8'));
    const head = /export type GeometryDescriptor\s*=/.exec(src);
    expect(head, 'the union must still be found by this parser').not.toBeNull();

    // Walk to the `;` that ends the DECLARATION, tracking brace depth. Written first as a
    // lazy `([\s\S]*?);` and that was wrong in a way worth recording: the arms are object
    // types full of `;` separators, so the match ended inside the second arm and the census
    // reported two kinds where there are six — a census silently reading a SMALLER subject,
    // which is the failure mode every gate in this repo is most exposed to. It reported a
    // clean four-kind classification as a mismatch only because the expected list was exact.
    let depth = 0;
    let i = head!.index + head![0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const body = src.slice(head!.index + head![0].length, i);
    const kinds = [...body.matchAll(/readonly kind:\s*'([a-z]+)'/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual(Object.keys(HANDLE_KINDS).sort());
  });

  it('names every descriptor field after a real param on the producing node', () => {
    // The correspondence itself. A field with no same-named param is a field no animation can
    // ever reach — the original freeze, restored by a rename, with nothing else going red.
    const unreachable: string[] = [];
    for (const [kind, entry] of Object.entries(HANDLE_KINDS)) {
      if (!entry.producer) continue;
      const params = declaredParamKeys(entry.producer);
      for (const field of descriptorParamFields(entry.ref.descriptor)) {
        if (!params.includes(field)) unreachable.push(`${kind}.${field} (${entry.producer})`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it('moves the key when any single field is folded in', () => {
    // The half a name check cannot see: that each field is genuinely BUILT FROM. An arm that
    // read the right names and dropped one would pass the case above and freeze that param
    // alone — the narrowest possible version of this bug.
    const ignored: string[] = [];
    for (const [kind, entry] of Object.entries(HANDLE_KINDS)) {
      if (!entry.producer) continue;
      for (const field of descriptorParamFields(entry.ref.descriptor)) {
        const rebuilt = rebuildGeometryRef(entry.ref, { [field]: probeFor(field, kind) });
        if (rebuilt.key === entry.ref.key) ignored.push(`${kind}.${field}`);
      }
    }
    expect(ignored).toEqual([]);
  });

  it('never exposes a nested source handle as a param field', () => {
    // `source` is another producer's minted identity. Folding a param write into it would
    // repoint this modifier at geometry its own producer never agreed to.
    for (const kind of ['array', 'mirror']) {
      const d = HANDLE_KINDS[kind].ref.descriptor as unknown as Record<string, unknown>;
      expect(Object.keys(d), `${kind} must actually have a source to exclude`).toContain('source');
      expect(descriptorParamFields(HANDLE_KINDS[kind].ref.descriptor)).not.toContain('source');
    }
  });

  it('leaves an asset-keyed handle strictly alone', () => {
    // gltf and baked are keyed by an asset reference and by a content hash of bytes in OPFS.
    // Re-minting either here would be a second spelling of a key this module does not own —
    // and for `baked`, a fabricated hash pointing at bytes that do not exist.
    for (const kind of ['gltf', 'baked']) {
      const { ref } = HANDLE_KINDS[kind];
      expect(rebuildGeometryRef(ref, { hash: 'x', assetRef: 'y', size: [9, 9, 9] })).toBe(ref);
    }
  });

  it('returns the ref by reference when nothing it builds from was written', () => {
    // What keeps an animated position from re-minting a geometry key — and therefore from
    // costing two objects their shared build.
    const { ref } = HANDLE_KINDS.box;
    expect(rebuildGeometryRef(ref, {})).toBe(ref);
    // A written param that is real but feeds a DIFFERENT descriptor kind must not fold in
    // either: `radius` is nothing to a box.
    expect(rebuildGeometryRef(ref, { radius: 5 })).toEqual(boxGeometryRef([1, 1, 1], null));
  });
});

// ── QUESTION 5 — ns-2 (D8): THE HANDLE SAYS ITS KIND EXACTLY ONCE ──────────────────────

describe('ns-2 D8 — a geometry handle carries no second spelling of its kind', () => {
  /**
   * The members `interface GeometryRef` declares, read off the source.
   *
   * Brace-walked rather than lazily matched, for the reason question 1's parser records in
   * its own comment: an interface body is full of `;` separators and nested doc comments, so
   * a `([\s\S]*?)\}` would end at the first inner brace and censusa SMALLER subject —
   * reporting a clean two-member shape while reading one line.
   */
  function geometryRefMembers(): string[] {
    const src = stripComments(readFileSync(SOURCE, 'utf8'));
    const head = /export interface GeometryRef\s*\{/.exec(src);
    // The parser must find its subject before any count it produces means anything: a zero
    // from a regex that matched nothing is indistinguishable from a zero that was measured.
    expect(head, 'the interface must still be found by this parser').not.toBeNull();
    let depth = 1;
    let i = head!.index + head![0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(head!.index + head![0].length, i - 1);
    expect(
      body.length,
      'the body must be non-empty — an empty parse decides nothing',
    ).toBeGreaterThan(0);
    return [...body.matchAll(/readonly\s+([A-Za-z_$][\w$]*)\??\s*:/g)].map((m) => m[1]).sort();
  }

  it('declares key + descriptor + attributeKey, and no `kind` of its own', () => {
    // ── THE CENSUS'S OWN VALUE, BEFORE AND AFTER, AS LITERALS ─────────────────────────
    // Required of any census here, because a number that reads the same on both trees is
    // measuring something other than the change however the assertion is phrased:
    //
    //     PRE  step 8 : ['attributeKey', 'descriptor', 'key', 'kind']   (4 members)
    //     POST step 8 : ['attributeKey', 'descriptor', 'key']           (3 members)
    //
    // Verified by restoring the pre-step file and watching this row red on the word `kind`.
    //
    // 🔴 THIS ROW IS THE SOLE DETECTOR, AND THAT IS A MEASUREMENT, NOT A PRECAUTION. Step 8
    // was expected to make the two-field disagreement UNCONSTRUCTIBLE, and it does only for
    // the shape that was removed: re-adding `readonly kind` as REQUIRED reds `tsc` at 8
    // construction sites, so the compiler owns that case. Re-adding it as OPTIONAL —
    // `readonly kind?:` — was measured too, and it is a different world: **typecheck 0
    // errors, 4157 of 4158 tests green, and this row the only thing red.** The drift comes
    // back silently through one question mark. So the honest grade for D8 is a GATE, not an
    // unconstructible state, and weakening this row leaves the boundary with no detector at
    // all — the same distinction ns-2 has already paid to keep straight twice.
    expect(geometryRefMembers()).toEqual(['attributeKey', 'descriptor', 'key']);
  });

  it('and the two exhaustive dispatches now close on the SAME union', () => {
    // The reason the field went, stated as the thing that is now true. `availabilityOf` used
    // to take `GeometryRef['kind']` and `faceCountOf` to take the descriptor — two `never`
    // closures over two independently-written spellings, with nothing asserting they agreed.
    // Adding a seventh descriptor arm redded `faceCountOf` and `rebuildGeometryRef` and left
    // `availabilityOf` compiling clean, while its comment promised a COMPILE ERROR in
    // capitals. A `never` closed on a second spelling guards the spelling, not the subject.
    //
    // #708 — the parameter is now the DESCRIPTOR ITSELF, not its kind, and that is strictly
    // stronger for what this row guards. The `never` still closes on the descriptor union,
    // and taking the whole descriptor is what lets `availabilityOf` reach `.source` — so the
    // un-composed question, which is what produced a false answer for every generator over a
    // buffer, is no longer askable. The second assertion below is the actual regression
    // guard and is untouched: the hand-written union must not return as a parameter type.
    const src = stripComments(readFileSync(join(__dirname, 'geometryRegistry.ts'), 'utf8'));
    expect(src, 'availabilityOf must close on the descriptor union').toContain(
      'availabilityOf(descriptor: GeometryDescriptor)',
    );
    expect(src, 'the hand-written union must not come back as a parameter type').not.toContain(
      "GeometryRef['kind']",
    );
  });

  it('every constructible handle answers its kind through the descriptor alone', () => {
    // Behavioural half: the four param-fed builders and the two reference kinds all report a
    // kind, and they report it from one place. `Object.keys` is the discriminator — a handle
    // that regrew a second field would still answer correctly here and would fail this.
    for (const [kind, { ref }] of Object.entries(HANDLE_KINDS)) {
      expect(ref.descriptor.kind, `${kind} descriptor`).toBe(kind);
      expect(Object.keys(ref), `${kind} handle surface`).not.toContain('kind');
    }
  });
});

// #1027 gate 1 — A NAMED GROUP IS AUTHORED, CARRIED, AND ADDRESSABLE-IN-PRINCIPLE.
//
// ── WHAT EACH ROW HOLDS, AND WHY THE LAST TWO ARE THE ONES WORTH READING ──────────────
//
// Rows 1-5 are the operator's behaviour. Row 6 is the discriminating half of #734 minus the
// name: the membership survives a topology change. Rows 7-8 are the TIE between two modules
// that never import each other — `componentGroups`'s charset and `scopeQuery`'s grammar.
//
// 🔴 ROW 7 EXISTS BECAUSE A COMMENT CANNOT HOLD A RELATIONSHIP. `componentGroups` says its
// charset is "the query grammar's complement, spelled as a charset". Nothing about that is
// enforced by either module — they share no import, by design — so it is exactly the shape
// this repo has paid for seven times: a sentence asserting a rule the code does not check.
// The row asks the grammar directly, per name: a valid group name must be refused AS A NAME
// ("named groups are not implemented"), and an invalid one must NOT be, because if it were
// the charset would be refusing something the grammar could in fact address.
//
// ⚠️ FALSIFIED PER GUARD, NOT PER FIX ([[H779]]) — the suite going green is not evidence, and
// two guards that are each sufficient for the same case make each other untestable. Measured,
// one broken thing at a time:
//
//   remove the blank-name transparency          -> row 4
//   mint drops the carried set                  -> rows 2, 3
//   group goes FIRST instead of last            -> row 3
//   selection inverted                          -> rows 1, 3, 5, 6
//   charset admits `-`                          -> row 7
//   groupNameOf trusts the prefix               -> row 8
//   a missing group resolves to EVERYTHING      -> row 10
//   a missing group resolves to NOTHING         -> row 10
//   the lookup ignores the SCOPE's domain       -> row 10
//   the lookup ignores the ATTRIBUTE's domain   -> row 11
//   a group term is parsed as a range           -> rows 7, 9, 10
//   the canonicaliser drops group terms         -> row 7
//   OVER-BROAD: every face a member, always     -> rows 1, 3, 6
//
// 🔴 ROW 11 EXISTS ONLY BECAUSE OF THIS EXERCISE, and it is the entry worth reading twice. The
// attribute-domain guard survived its own falsifier with every other row green — the state it
// prevents is never MINTED, so nothing reached it. Reading the code is what separated "untested"
// from "dead": an attribute set is data, so a `group:` name at the corner domain is
// constructible even though this writer cannot produce one. A green falsifier is a question,
// never an answer.
//
// Every guard reds a row alone, so none is untested or dead. 🔴 THE OVER-BROAD CONTROL IS THE
// LINE WORTH READING: it leaves ROW 5 GREEN, because "unscoped names every face" is exactly
// what an always-true membership produces. Row 5 therefore holds the DEFAULT and cannot hold
// the selection — row 1 does that. Anyone tempted to treat row 5 as coverage of the scope has
// the measurement here saying it is not.
//
// REF: src/nodes/componentGroups.ts, src/nodes/ComponentGroupOp.ts,
//      src/nodes/meshAttributes.ts (`mintGroupAttributes`), src/nodes/scopeQuery.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, getNodeType } from '../core/dag';
import { registerAllNodes } from './registerAll';
import { resolveComponentSelection } from './componentSelection';
import {
  boxGeometryRef,
  boxDescriptor,
  arrayGeometryRef,
  refWithAttributeKey,
} from '../app/modifierGeometry';
import { mintMeshAttributes, mintTiledModifierAttributes } from './meshAttributes';
import { hydrateInlineMaterial } from './materialSchema';
import { insert, read } from '../app/attributeStore';
import { mintAttributes } from './attributeKey';
import { canonicalScopeQuery, scopeSelection } from './scopeQuery';
import { groupLookupFor } from '../app/componentGroupLookup';
import { faceCountOf } from '../app/faceCount';
import { groupAttributeName, groupNameOf, isValidGroupName } from './componentGroups';
import { MATERIAL_INDEX } from './attributes';
import type { AttributeData } from './attributes';
import type { MeshDataValue, ObjectData } from './types';

const ctx = { time: { frame: 0, seconds: 0, normalized: 0 } };
const ARM = groupAttributeName('arm');

/** A box: six faces, so `0-2` is an unambiguous proper subset with three on each side. */
function boxSource(): MeshDataValue {
  const descriptor = boxDescriptor([1, 1, 1]);
  const attributeKey = mintMeshAttributes(descriptor, 'evaluate');
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], attributeKey),
    material: hydrateInlineMaterial(null, '#808080'),
    materialKey: null,
    attributeKey,
  };
}

/** Run the operator the way the evaluator does — the selection from the ONE resolver. */
function runGroupOp(src: ObjectData, params: Record<string, unknown>): ObjectData {
  const def = getNodeType('ComponentGroupOp')!;
  return def.evaluate(
    params as never,
    { target: src } as never,
    ctx as never,
    resolveComponentSelection(src, params, 'face'),
  ) as ObjectData;
}

/** The membership `name` holds on whatever attribute key `out` carries. */
function membership(out: ObjectData, name = ARM): number[] | null {
  const key = (out as { attributeKey?: string }).attributeKey;
  if (key === undefined) return null;
  const set = read(key);
  const attr = set?.[name];
  return attr ? [...attr.data] : null;
}

describe('#1027 — a named component group', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    registerAllNodes();
  });

  it('row 1 — writes the name onto the faces its scope names, and 0 elsewhere', () => {
    const out = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    expect(membership(out)).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it('row 2 — carries what the source already had rather than replacing the set', () => {
    const out = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    const key = (out as { attributeKey?: string }).attributeKey!;
    const set = read(key)!;
    // The box's own material assignment must still be there beside the new group.
    expect(Object.keys(set).sort()).toEqual([ARM, MATERIAL_INDEX].sort());
  });

  it('row 3 — re-authoring one name REPLACES it; the later statement is the one meant', () => {
    const first = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    const second = runGroupOp(first, { name: 'arm', scope: '3-5', muted: false });
    expect(membership(second)).toEqual([0, 0, 0, 1, 1, 1]);
    // And exactly one `arm`, not two entries that happen to collide on read.
    expect(Object.keys(read((second as { attributeKey?: string }).attributeKey!)!)).toHaveLength(2);
  });

  it('row 4 — a blank name is transparent: the SAME object, not an equal one', () => {
    const src = boxSource();
    // Identity, not deep equality. A node that minted `group:` and re-keyed the geometry
    // would produce something deep-equal in every field a casual assertion would check.
    expect(runGroupOp(src, { name: '', scope: '0-2', muted: false })).toBe(src);
  });

  it('row 5 — an unscoped group names EVERY face (the reference default, not a fallback)', () => {
    const out = runGroupOp(boxSource(), { name: 'arm', scope: '', muted: false });
    expect(membership(out)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('row 6 — THE DISCRIMINATING HALF: the membership survives a topology change', () => {
    const out = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    const geometry = (out as { geometry: ReturnType<typeof boxGeometryRef> }).geometry;
    const arrayed = arrayGeometryRef(geometry, 3, [2, 0, 0]);
    const tiled = mintTiledModifierAttributes(arrayed.descriptor);
    expect(tiled).not.toBeNull();
    expect([...read(tiled!)![ARM].data]).toEqual([
      1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0,
    ]);
  });

  it('row 7 — THE TIE: every name this charset admits ROUND-TRIPS through the grammar', () => {
    const valid = ['arm', 'Arm', '_arm', 'arm2', 'arm_left', 'A'];
    const invalid = ['arm-left', 'arm:left', 'arm*', '@arm', '0arm', 'arm left', 'arm,leg', ''];

    for (const name of valid) {
      expect(isValidGroupName(name), `${name} should be a valid group name`).toBe(true);
      // 🔴 THE ROUND TRIP, WHICH IS NOW LITERAL. `componentGroups` says its charset is the set
      // of names the grammar reads as names; the two modules share no import, so nothing but
      // this row holds that. A name the grammar read as a RANGE, or refused, would come back
      // as something other than itself — and at gate 3 that means a group nothing can address.
      expect(canonicalScopeQuery(name), name).toBe(name);
    }
    for (const name of invalid) {
      expect(isValidGroupName(name), `${name} should NOT be a valid group name`).toBe(false);
    }

    // 🔴 THE CONTAINMENT IS PROPER, AND THIS ROW LEARNED IT THE HARD WAY. It first asserted the
    // charset MIRRORED the grammar and went red: the grammar decides "is this a name?" with a
    // PREFIX test, so `arm-left` is read as a name too. It is refused with the NAME's charset
    // rather than the range's, which is the correct half of being wrong — the author reached
    // for a group, so they are sent to the group rule.
    expect(isValidGroupName('arm-left')).toBe(false);
    expect(() => canonicalScopeQuery('arm-left')).toThrow(/is not a group name/);
    // Controls, so none of the above can pass for a reason unrelated to names: a range still
    // canonicalises untouched, and a name is not silently absorbed into one.
    expect(canonicalScopeQuery('0-2')).toBe('0-2');
    expect(canonicalScopeQuery('arm 0-2')).toBe('0-2 arm');
  });

  it('row 9 — THE DISCRIMINATING OBSERVATION: name a region, array it, address it BY NAME', () => {
    // The whole point of the chain, end to end, with nothing hand-fed between the steps.
    const named = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    const geometry = (named as { geometry: ReturnType<typeof boxGeometryRef> }).geometry;

    // A real topology change: six faces become eighteen.
    const arrayed = arrayGeometryRef(geometry, 3, [2, 0, 0]);
    const tiledKey = mintTiledModifierAttributes(arrayed.descriptor)!;
    const propagated = refWithAttributeKey(arrayed, tiledKey);
    expect(faceCountOf(propagated.descriptor)).toBe(18);

    // …and the NAME still resolves, against the mesh as it is NOW. Not re-authored, not
    // re-scoped: the same four letters the director typed before the array existed.
    const byName = scopeSelection('arm', 18, groupLookupFor(propagated, 'face'));
    expect([...byName.mask]).toEqual([1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
    expect(byName.count).toBe(9);

    // The control that makes it an observation rather than a coincidence: the equivalent
    // NUMERIC query, which is what a director would have had to write instead, names the first
    // three faces of the arrayed mesh and nothing else. The name tracked the topology; the
    // index did not, which is the entire difference the feature buys.
    const byIndex = scopeSelection('0-2', 18, groupLookupFor(propagated, 'face'));
    expect(byIndex.count).toBe(3);
  });

  it('row 10 — an unresolvable name is refused BY NAME, never as "everything" or "nothing"', () => {
    const named = runGroupOp(boxSource(), { name: 'arm', scope: '0-2', muted: false });
    const geometry = (named as { geometry: ReturnType<typeof boxGeometryRef> }).geometry;
    const groups = groupLookupFor(geometry, 'face');

    // The founding failure of this module, in both directions: a group nobody created must not
    // quietly mean the whole mesh (a masked operator would act everywhere) and must not quietly
    // mean nothing (a mask would delete the mesh).
    expect(() => scopeSelection('leg', 6, groups)).toThrow(/no group named 'leg'/);
    // A reader that was never given a lookup is a WIRING defect, and says so rather than
    // blaming the author's query — different facts, different fixes.
    expect(() => scopeSelection('arm', 6)).toThrow(/was given no way to resolve one/);
    // And a face group cannot scope an EDGE selection: the mesh may well carry `arm`, so
    // "no such group" would be the false sentence.
    expect(() => scopeSelection('arm', 12, groupLookupFor(geometry, 'edge'))).toThrow(
      /groups are face-domain/,
    );
    // The positive control: with the right lookup at the right class, it resolves.
    expect(scopeSelection('arm', 6, groups).count).toBe(3);
  });

  it('row 11 — a group name at the WRONG DOMAIN is not a group, however it is spelled', () => {
    // 🔴 THIS ROW EXISTS BECAUSE ITS GUARD SURVIVED ITS OWN FALSIFIER. Removing the domain
    // check in `groupLookupFor` left every other row green — the state is never MINTED here,
    // since the writer always mints at `face`. It is representable all the same: an attribute
    // set is data and can arrive from a save file or a future producer, so `group:arm` at the
    // corner domain is constructible even though nothing constructs it today. Reading the code
    // is what said "untested" rather than "dead", and this is the case where only that guard
    // applies.
    //
    // What it prevents: corner values read against FACE indices. Both are integers, both are
    // in range, and the mesh that comes back is simply the wrong one.
    const faces = faceCountOf(boxDescriptor([1, 1, 1]))!;
    const corner: AttributeData = {
      domain: 'corner',
      type: 'int',
      count: 24,
      data: new Int32Array(24).fill(1),
    };
    const minted = mintAttributes({ [ARM]: corner })!;
    insert(minted.key, minted.set, 'evaluate');
    const geometry = boxGeometryRef([1, 1, 1], minted.key);

    // Refused by name — NOT silently resolved against the wrong domain, and not "everything".
    expect(() => scopeSelection('arm', faces, groupLookupFor(geometry, 'face'))).toThrow(
      /no group named 'arm'/,
    );

    // The positive control, so the refusal is about the DOMAIN and not about the name, the
    // prefix, or the store: the identical set at `face` resolves.
    const atFace: AttributeData = {
      domain: 'face',
      type: 'int',
      count: faces,
      data: new Int32Array(faces).fill(1),
    };
    const ok = mintAttributes({ [ARM]: atFace })!;
    insert(ok.key, ok.set, 'evaluate');
    expect(
      scopeSelection('arm', faces, groupLookupFor(boxGeometryRef([1, 1, 1], ok.key), 'face')).count,
    ).toBe(faces);
  });

  it('row 8 — a group name is re-validated on the way OUT, not trusted from the prefix', () => {
    expect(groupNameOf(ARM)).toBe('arm');
    expect(groupNameOf(MATERIAL_INDEX)).toBeNull();
    // Representable from a save file or a future producer, and it must NOT come back as a
    // name: the resolver would read `0-5` as a RANGE, so a group called that would silently
    // mean six faces.
    expect(groupNameOf('group:0-5')).toBeNull();
    expect(groupNameOf('group:arm*')).toBeNull();
  });
});

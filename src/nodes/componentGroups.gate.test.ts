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
//   OVER-BROAD: every face a member, always     -> rows 1, 3, 6
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
import { boxGeometryRef, boxDescriptor, arrayGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes, mintTiledModifierAttributes } from './meshAttributes';
import { hydrateInlineMaterial } from './materialSchema';
import { read } from '../app/attributeStore';
import { canonicalScopeQuery } from './scopeQuery';
import { groupAttributeName, groupNameOf, isValidGroupName } from './componentGroups';
import { MATERIAL_INDEX } from './attributes';
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

  it('row 7 — THE TIE: the charset is exactly the set of names the grammar reads AS names', () => {
    const valid = ['arm', 'Arm', '_arm', 'arm2', 'arm_left', 'A'];
    const invalid = ['arm-left', 'arm:left', 'arm*', '@arm', '0arm', 'arm left', 'arm,leg', ''];

    for (const name of valid) {
      expect(isValidGroupName(name), `${name} should be a valid group name`).toBe(true);
      // Refused AS A NAME — the grammar recognises it and says the construct is not built
      // yet. That is what makes it addressable the moment gate 3 lands.
      expect(() => canonicalScopeQuery(name), name).toThrow(/named groups are not implemented/);
    }
    for (const name of invalid) {
      expect(isValidGroupName(name), `${name} should NOT be a valid group name`).toBe(false);
    }
    // The load-bearing direction, asserted as a set relation rather than left to the loop
    // above: nothing this charset admits may reach the RANGE parser. Every valid name throws
    // the name refusal, which is only reachable before the range parser runs.
    for (const name of valid) {
      expect(() => canonicalScopeQuery(name), `${name} must not parse as a range`).toThrow(
        /named groups are not implemented/,
      );
    }
    // 🔴 THE CONTAINMENT IS PROPER, AND THIS ROW LEARNED IT THE HARD WAY. It first asserted
    // that a refused name falls into the GENERIC refusal — i.e. that the charset mirrored the
    // grammar — and went red: the grammar's name test is a PREFIX test, so `arm-left` is read
    // as a name too and refused as not-implemented. Pinned in the direction that is actually
    // true, so the next reader inherits the measurement instead of the guess.
    expect(() => canonicalScopeQuery('arm-left')).toThrow(/named groups are not implemented/);
    expect(isValidGroupName('arm-left')).toBe(false);
    // And the control that keeps this row honest — a RANGE must not be refused at all,
    // otherwise every `toThrow` above would pass for a reason unrelated to names.
    expect(canonicalScopeQuery('0-2')).toBe('0-2');
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

// #645 P1 — THE OBJECT-SIDE SLOT OVERRIDE AS A DATA MODEL: what can be said, what cannot
// be said, and what an existing project costs.
//
// ── WHAT P1 IS AND IS NOT ─────────────────────────────────────────────────────────────
//
// P1 gives the Object a place to say "my slot n points somewhere else". It does NOT make
// anything read it — the derivation still resolves off the data value, so nothing in these
// rows renders differently. That is deliberate and it is counted rather than assumed: the
// fuse in `objectSlotTable.gate.test.ts` asserts the production reader count is zero, and
// reds on the first one. A field nothing reads is precisely the shape that made this work
// necessary, so it is held open by a failing count rather than by a comment.
//
// ── THE THREE THINGS A DATA MODEL DECIDES, AND THE ONE THIS ONE REFUSES ───────────────
//
// The reference stores a per-slot `link` of `OBJECT | DATA` beside a material that may
// independently be empty. That is three states per slot, and the third — link is OBJECT,
// material is None — is a real one there, with its own handling.
//
// Here PRESENCE is the link mode. An entry means `link == OBJECT`; no entry means
// `link == DATA`; and because the record's value type has no null member, "link is OBJECT
// but nothing is set" has no constructor at all. The state is not guarded against, it is
// unsayable — which is the rung of the ladder that needs no test to stay true, only a type.
//
// REF: ref/GROUND_TRUTH_BLENDER_RENDER_RESOURCE_IDENTITY.md §6 (the per-slot re-point);
//      src/nodes/types.ts (`ObjectValue.slotOverrides` — why a record, not a sparse array);
//      src/nodes/objectSlotTable.gate.test.ts (the fuse chain); issues #645, #638.

import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectNode, ObjectParams } from './ObjectNode';
import { registerAllNodes } from './registerAll';
import { hydrateInlineMaterial } from './materialSchema';
import { boxDescriptor, boxGeometryRef } from '../app/modifierGeometry';
import { mintMeshAttributes } from './meshAttributes';
import type { MeshDataValue, ObjectValue } from './types';

function sharedBoxData(): MeshDataValue {
  const key = mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate');
  return {
    kind: 'MeshData',
    geometry: boxGeometryRef([1, 1, 1], key),
    material: hydrateInlineMaterial(null, '#ff0000'),
    materialKey: null,
    attributeKey: key,
  };
}

function evalObject(params: Record<string, unknown>, data: MeshDataValue | null): ObjectValue {
  return ObjectNode.evaluate(
    ObjectParams.parse(params),
    { data: data ?? undefined } as never,
    undefined as never,
  ) as ObjectValue;
}

beforeEach(() => {
  registerAllNodes();
});

describe('#645 P1 — an Object can carry per-slot material overrides', () => {
  it('an Object that overrides nothing evaluates without the key at all — not to an empty record', () => {
    const value = evalObject({}, sharedBoxData());

    // ABSENT, not `{}`. The distinction is the whole no-migration argument: an existing
    // saved project has no such key, parses unchanged, and evaluates to the same shape it
    // evaluated to before this field existed. `toBeUndefined` alone would pass for `{}`
    // under some spellings, so the key's presence is asked directly.
    expect('slotOverrides' in value).toBe(false);
    expect(value.slotOverrides).toBeUndefined();
  });

  it('an authored override survives the schema and reaches the value', () => {
    const value = evalObject(
      { slotOverrides: { '1': { name: 'accent', base: { color: '#00ff00' } } } },
      sharedBoxData(),
    );

    expect(Object.keys(value.slotOverrides ?? {})).toEqual(['1']);
    expect(value.slotOverrides?.['1'].base.color).toBe('#00ff00');
    // The schema fills the rest of the material rather than handing a partial down: a
    // half-built spec reaching the renderer is how a slot silently loses its roughness.
    expect(value.slotOverrides?.['1'].specular.roughness).toBeTypeOf('number');
  });

  it('the override is SPARSE — overriding slot 2 says nothing about slots 0 and 1', () => {
    const value = evalObject(
      { slotOverrides: { '2': { base: { color: '#0000ff' } } } },
      sharedBoxData(),
    );

    // The absence of 0 and 1 is the representation of `link == DATA` for those slots. If
    // this ever became a dense array the absence would have to be spelled as a value, and
    // the only available value is `null`, which the data-side table already uses to mean
    // "this slot has no material" — two different claims collapsing onto one byte.
    expect(Object.keys(value.slotOverrides ?? {})).toEqual(['2']);
    expect(value.slotOverrides?.['0']).toBeUndefined();
    expect(value.slotOverrides?.['1']).toBeUndefined();
  });

  it('a non-index key is refused at the schema, where it is authored', () => {
    // Refused rather than ignored. A silently-dropped key would author an override that
    // never applies and give the author no signal — the failure mode the whole slot-table
    // area has been paying for.
    expect(() => ObjectParams.parse({ slotOverrides: { first: { name: 'x' } } })).toThrow();
    expect(() => ObjectParams.parse({ slotOverrides: { '-1': { name: 'x' } } })).toThrow();
    expect(() => ObjectParams.parse({ slotOverrides: { '1.5': { name: 'x' } } })).toThrow();

    // 🔑 THE CONTROL, without which the three throws above prove nothing. The same VALUE
    // under a VALID key parses cleanly, so the refusals are about the KEY and not about a
    // partial material the value schema happened to reject. Measured: this was checked
    // before the rows above were trusted.
    const ok = ObjectParams.parse({ slotOverrides: { '3': { name: 'x' } } });
    expect(Object.keys(ok.slotOverrides ?? {})).toEqual(['3']);
  });

  it("Blender's empty-object-slot state has no constructor here", () => {
    // `link == OBJECT` with no material is a real state in the reference and is not one
    // here: the record's value type admits no null. This is asserted through the SCHEMA
    // rather than the type, because a type-level claim cannot fail at runtime and the
    // question is what an authored project can actually contain.
    expect(() => ObjectParams.parse({ slotOverrides: { '0': null } })).toThrow();

    // And the empty record is not a way to spell it either — it parses, but it carries no
    // slot, so it makes no claim about any slot's link mode.
    const empty = ObjectParams.parse({ slotOverrides: {} });
    expect(Object.keys(empty.slotOverrides ?? {})).toEqual([]);
  });

  it('an empty override record does NOT reach the value — one meaning, one spelling', () => {
    // `{}` is reachable: it is what removing the last override leaves behind. If it were
    // carried through, "this Object overrides nothing" would have two spellings on the
    // value — absent, and an empty record — and every reader downstream would have to
    // know both. The neighbours in `types.ts` record what that costs: `uvs: null` carried
    // three situations with three different correct responses and was deleted for it.
    //
    // Found in review of this commit's own diff, not designed in: the first spelling
    // carried any truthy record, and `{}` is truthy.
    const value = evalObject({ slotOverrides: {} }, sharedBoxData());
    expect('slotOverrides' in value).toBe(false);

    // The control, so this is not passing because the field stopped working: a NON-empty
    // record still reaches the value from the same road.
    const real = evalObject({ slotOverrides: { '0': { name: 'x' } } }, sharedBoxData());
    expect('slotOverrides' in real).toBe(true);
  });

  it('survives a JSON round trip, and an Object without one serializes byte-identical', () => {
    // OBSERVED, not inferred from the schema. `NodeSchema.params` is `z.unknown()`, so the
    // project file carries params opaquely and the no-migration claim rests on the field
    // being plain JSON and absent by default — the same road `spare` and `meta.hidden`
    // take, and for the same stated reason. Both halves are cheap to actually run, so
    // they are run.
    const authored = ObjectParams.parse({
      slotOverrides: { '2': { name: 'accent', base: { color: '#00ff00' } } },
    });
    const revived = ObjectParams.parse(JSON.parse(JSON.stringify(authored)));
    expect(revived).toEqual(authored);
    expect(revived.slotOverrides?.['2'].base.color).toBe('#00ff00');

    // 🔑 THE HALF THAT MATTERS FOR EXISTING PROJECTS: a params object saved before this
    // field existed has no such key, and serializing what the schema makes of it puts no
    // key back. That is the whole no-migration argument, and it is what a `.default({})`
    // would have quietly broken by writing `"slotOverrides":{}` into every Object.
    const legacy = ObjectParams.parse({ position: [1, 2, 3] });
    expect(JSON.stringify(legacy)).not.toContain('slotOverrides');
  });

  it('two Objects over ONE data node can now be told apart — the promise the tree has been making', () => {
    const shared = sharedBoxData();
    const plain = evalObject({}, shared);
    const overridden = evalObject(
      { slotOverrides: { '0': { base: { color: '#00ff00' } } } },
      shared,
    );

    // The claim four places in `types.ts` and `materialAssignment.ts` have been making
    // since #638 — that two objects can share one mesh and still look different — is now
    // at least SAYABLE. It is not yet honoured: nothing reads this, which is what the
    // fuse in the gate file counts.
    expect(plain.slotOverrides).toBeUndefined();
    expect(overridden.slotOverrides?.['0']).toBeDefined();

    // 🔑 AND THE DATA VALUE IS UNTOUCHED — by identity, not equality. The reference's
    // "shared material datablock: never written" row, which is the property that makes an
    // object-level override cheap rather than a copy.
    expect(plain.data).toBe(shared);
    expect(overridden.data).toBe(shared);
  });
});

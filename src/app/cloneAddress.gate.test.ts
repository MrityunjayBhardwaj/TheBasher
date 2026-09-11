// #1015 — WHETHER a clone draws it and WHICH child draws it must stay ONE question.
//
// ── WHAT THIS GATE EXISTS TO CATCH ───────────────────────────────────────────────────
//
// `resolveMeshUVSpace` takes its clone arm on `cloneAddressOf(descriptor) !== null` and then
// resolves the residual arm through `primarySlotMaterial`, whose `elsewhere` case it declares
// unreachable. That claim is TRUE ONLY WHILE TWO CONDITIONS SELECT THE SAME SET:
//
//   · the arm is entered when `cloneAddressOf` answers — i.e. `availabilityOf === 'clone'`
//   · `absentSlot` is `'elsewhere'` when `availabilityOf === 'clone'`
//
// Both are defined in terms of `availabilityOf` today, which is exactly the kind of agreement
// that reads as a guarantee and is not one. 🔴 A COMMENT CLAIMING AN ENFORCEMENT THE CODE DOES
// NOT HAVE is this repo's most-repeated defect, and the bug this file was written for was its
// sibling: `descriptor.kind === 'gltf'` selected every clone-drawn mesh for three issues, the
// prose said so, and then `uvProject` arrived and the sets diverged in silence. The answer is
// not a better comment. It is a row that reds when the two sets part.
//
// ⚠️ NOT A RESTATEMENT OF THE `never`. The exhaustive switches in `availabilityOf` and
// `cloneAddressOf` catch a new KIND that nobody classified; the typecheck sees those. Neither
// can catch a kind classified INCONSISTENTLY across the two functions — routed to the clone
// class by one and not the other — which is the failure that blanks the UV editor.
//
// REF: src/app/geometryRegistry.ts (`availabilityOf`, `drawnByAssetClone`, `cloneAddressOf`);
//      src/app/materialAssignment.ts (`absentSlot`); src/app/resolveMeshUVSpace.ts
//      (`textureSourceOf` — the arm whose reachability claim this pins). Issues #1015, #605.

import { describe, expect, it } from 'vitest';
import {
  arrayGeometryRef,
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
  uvProjectGeometryRef,
} from './modifierGeometry';
import { availabilityOf, cloneAddressOf, drawnByAssetClone } from './geometryRegistry';
import { materialAssignmentOf } from './materialAssignment';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';

const box = boxGeometryRef([1, 1, 1], null);
const sphere = sphereGeometryRef(1, 8, 6, null);
const bakedRef: GeometryRef = {
  key: 'baked|b',
  descriptor: { kind: 'baked', hash: 'b', vertexCount: 3 },
};
const gltfRef: GeometryRef = {
  key: 'gltf|a|c',
  descriptor: { kind: 'gltf', assetRef: 'a', childName: 'c' },
};

/** One representative per kind. Typed as a Record over the union, so a new kind is a missing
 *  property and a TYPE error — the detector `edgeAngle.gate.test.ts:13` documents, with the
 *  same caveat: `npm run typecheck` excludes tests, so it surfaces in the changed-file sweep. */
const sample: Record<GeometryDescriptor['kind'], GeometryRef> = {
  box,
  sphere,
  array: arrayGeometryRef(box, 2, [2, 0, 0]),
  mirror: mirrorGeometryRef(box, 'x', 1),
  subset: subsetGeometryRef(box, '0-2', true),
  bevel: bevelGeometryRef(box, 0.1),
  uvProject: uvProjectGeometryRef(box, 2),
  gltf: gltfRef,
  baked: bakedRef,
};

/** The composed refs where the two rules could diverge — the ones a per-kind census cannot
 *  reach, because the answer depends on the SOURCE and not on the kind. */
const composed: readonly (readonly [string, GeometryRef])[] = [
  // The case that broke it. A projection over an imported mesh cannot materialise (its source
  // has no derivable arity), so it passes the clone availability through and IS clone-drawn,
  // while its kind is `uvProject`.
  ['uvProject over gltf (cannot materialise)', uvProjectGeometryRef(gltfRef, 2)],
  // Two deep — the walk has to recurse, not just peek one level down.
  ['uvProject over uvProject over gltf', uvProjectGeometryRef(uvProjectGeometryRef(gltfRef, 2), 3)],
  // A projection that DOES materialise builds its own buffers, so nothing else draws them.
  ['uvProject over box (materialises)', uvProjectGeometryRef(box, 2)],
  // A recipe over a clone source is built by the registry — `mounting`, not `clone`. The
  // Object draws it itself, and its absences are ours.
  ['array over gltf', arrayGeometryRef(gltfRef, 3, [1, 0, 0])],
  ['bevel over gltf', bevelGeometryRef(gltfRef, 0.1)],
  [
    'uvProject over array over gltf',
    uvProjectGeometryRef(arrayGeometryRef(gltfRef, 2, [1, 0, 0]), 2),
  ],
];

describe('#1015 — the clone class is one rule, read three ways', () => {
  it('WHETHER and WHICH select the same set, on every kind', () => {
    const kinds = Object.keys(sample) as GeometryDescriptor['kind'][];
    expect(kinds.length, 'every descriptor kind is represented').toBe(9);

    for (const kind of kinds) {
      const d = sample[kind].descriptor;
      expect(
        cloneAddressOf(d) !== null,
        `${kind}: \`drawnByAssetClone\` says ${drawnByAssetClone(d)} and \`cloneAddressOf\` says ${cloneAddressOf(d) !== null}. A mesh something else is drawing but nothing can address is a blank UV editor; a mesh nothing is drawing but something can address is a second draw of one geometry (#367).`,
      ).toBe(drawnByAssetClone(d));
    }
  });

  it('…and on the COMPOSED refs, where the answer depends on the source', () => {
    expect(composed.length, 'composed refs examined').toBe(6);
    for (const [name, ref] of composed) {
      const d = ref.descriptor;
      expect(cloneAddressOf(d) !== null, `${name}`).toBe(drawnByAssetClone(d));
    }
  });

  it('an ABSENT slot says `elsewhere` on exactly the set the clone arm takes', () => {
    // 🔑 THIS IS THE ROW THAT PINS `textureSourceOf`'s REACHABILITY CLAIM. Its `elsewhere` arm
    // is declared unreachable because the clone arm above it takes every descriptor whose
    // absences are `elsewhere`. If these two sets ever part, that arm becomes live and a
    // clone-drawn mesh silently loses its backdrop again — which is the whole defect.
    const all: readonly (readonly [string, GeometryRef])[] = [
      ...(Object.keys(sample) as GeometryDescriptor['kind'][]).map((k) => [k, sample[k]] as const),
      ...composed,
    ];
    expect(all.length, 'refs examined').toBe(15);

    for (const [name, ref] of all) {
      const absent = materialAssignmentOf(null, [null], ref).absentSlot;
      expect(
        absent === 'elsewhere',
        `${name}: absentSlot is '${absent}' while availabilityOf is '${availabilityOf(ref.descriptor)}'. \`textureSourceOf\`'s \`elsewhere\` arm is declared unreachable on the strength of these agreeing.`,
      ).toBe(cloneAddressOf(ref.descriptor) !== null);
    }
  });

  it('the address names the child that actually draws, through the whole chain', () => {
    // Not just "an address" — the RIGHT one. A walk that stopped at the first `gltf` it met
    // would pass the set rows above and still hand the UV editor the wrong mesh.
    const projected = uvProjectGeometryRef(uvProjectGeometryRef(gltfRef, 2), 3);
    expect(cloneAddressOf(projected.descriptor)).toEqual({
      kind: 'gltf',
      assetRef: 'a',
      childName: 'c',
    });
    expect(cloneAddressOf(box.descriptor)).toBeNull();
  });
});

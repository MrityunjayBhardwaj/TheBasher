// #800 — AN EDGE'S ANGLE IS DERIVABLE TODAY, AND IT IS BLENDER'S ANGLE AND NOT THE OTHER ONE.
//
// ── WHAT THIS GATE IS A DETECTOR FOR ─────────────────────────────────────────────────────
//
// Three things, and only the second is obvious:
//
//   1. That the angle composes through `array` / `mirror` / `subset` — the same demand every
//      derived quantity in this arc has had to meet.
//   2. That a box reads 90°. Necessary, and WORTHLESS ON ITS OWN: a box's interior dihedral is
//      also 90°, so this row cannot tell Blender's deviation-from-flat from its opposite. It is
//      here to catch arithmetic, not to identify the definition.
//   3. 🔑 That a FINER SPHERE IS FLATTER. This is the row that identifies the definition, and it
//      is the reason the sphere population is graded rather than sampled: under the deviation
//      reading a sphere's angles fall toward zero as it is refined, and under the interior
//      dihedral they climb toward 180°. The two readings disagree by construction here, where on
//      a box they agree exactly.
//
// ⚠️ ZERO IS THREE DIFFERENT ANSWERS — flat, boundary, non-manifold — and the rows below pin
// that the adjacency, not the angle, is what tells them apart. TWO OF THE THREE, HONESTLY: no
// descriptor this substrate can build produces a non-manifold edge, so that arm is unreached
// and row 11 is the detector for the day it stops being. Found by falsification rather than by
// reading — relaxing `faces.length !== 2` to `< 1` in `edgeAnglesOf` left all ten rows GREEN,
// because on a population with no non-manifold edge the two rules cannot disagree.
//
// REF: src/app/edgeAngle.ts (the derivation); src/app/edgeIdentity.ts (`edgeFaceAdjacencyOf`,
//      the shared walk); manual/modeling/geometry_nodes/mesh/read/edge_angle.rst; issue #800.

import { describe, expect, it } from 'vitest';
import {
  arrayGeometryRef,
  bevelGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { getForRead } from './geometryRegistry';
import { builtFaceNormals, edgeAnglesOf } from './edgeAngle';
import { edgeCountOf, edgeFaceAdjacencyOf, edgeSetOf, weldedPolygonsOf } from './edgeIdentity';
import { cornerCountOf } from './faceCount';
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

/** The population `builtRims.gate.test.ts` runs — every sync-buildable descriptor. */
const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4], null),
  sphere,
  sphereGeometryRef(1, 32, 16, null),
  sphereGeometryRef(0.5, 3, 2, null),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphere, 2, [0, 3, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(sphere, 'x', 1),
  mirrorGeometryRef(box, 'x', 0),
  mirrorGeometryRef(mirrorGeometryRef(box, 'x', 1), 'y', 1),
  subsetGeometryRef(box, '0', true),
  subsetGeometryRef(box, '0-2', true),
  subsetGeometryRef(box, '0-2', false),
  subsetGeometryRef(sphere, '0-9', true),
  arrayGeometryRef(box, 3, [2, 0, 0], '0-2'),
  mirrorGeometryRef(box, 'x', 1, '0-2'),
];

const deg = (radians: number) => (radians * 180) / Math.PI;

function anglesOf(ref: GeometryRef): Float32Array {
  const geometry = getForRead(ref);
  expect(geometry, 'built geometry').toBeTruthy();
  const angles = edgeAnglesOf(ref, geometry!);
  expect(angles, 'angles').not.toBeNull();
  return angles!;
}

describe('#800 — the derivation answers for every descriptor the edge walk answers for', () => {
  it('1 — one angle per edge, against the count the substrate declares', () => {
    expect(SYNC_BUILDABLE.length, 'population — a shrinking one is a vacuous gate').toBe(17);
    let totalEdges = 0;
    for (const ref of SYNC_BUILDABLE) {
      const declared = edgeCountOf(ref.descriptor);
      expect(declared.kind, `${ref.key} declares a count`).toBe('counted');
      const angles = anglesOf(ref);
      expect(angles.length, `${ref.key} — one angle per edge`).toBe(
        (declared as { count: number }).count,
      );
      totalEdges += angles.length;
    }
    // The denominator, MEASURED and asserted, so a population that silently stopped building
    // reds here. (Written from the run rather than from arithmetic: the first draft of this
    // line carried a guessed 2564 and was wrong by half a population.)
    expect(totalEdges, 'edges measured across the population').toBe(1696);
  });

  it('2 — the adjacency is index-aligned with the edge SET, because one walk numbers both', () => {
    for (const ref of SYNC_BUILDABLE) {
      const set = edgeSetOf(ref.descriptor)!;
      const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
      const rims = weldedPolygonsOf(ref.descriptor)!;
      expect(adjacency.faces.length, `${ref.key} counts agree`).toBe(set.count);
      for (let e = 0; e < set.count; e++) {
        const lo = set.pairs[2 * e];
        const hi = set.pairs[2 * e + 1];
        // Every face the adjacency names for edge `e` must actually contain that pair. This is
        // what would red if the two answers were built against different radices — each would
        // still be internally plausible, and only the cross-check sees it.
        for (const f of adjacency.faces[e]) {
          const rim = rims[f];
          let found = false;
          for (let i = 0; i < rim.length; i++) {
            const p = rim[i];
            const q = rim[(i + 1) % rim.length];
            if ((p === lo && q === hi) || (p === hi && q === lo)) found = true;
          }
          expect(found, `${ref.key} edge ${e} really lies on face ${f}`).toBe(true);
        }
      }
    }
  });

  it('3 — the incidences sum to the CORNER count, tying this walk to the corner domain', () => {
    for (const ref of SYNC_BUILDABLE) {
      const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
      const incidences = adjacency.faces.reduce((n, fs) => n + fs.length, 0);
      expect(incidences, `${ref.key} — every (face, edge) incidence is a corner`).toBe(
        cornerCountOf(ref.descriptor),
      );
    }
  });
});

describe('#800 — the angle is Blender’s, and the sphere is what proves it', () => {
  it('4 — a box is 12 edges at 90°, which is NECESSARY AND NOT SUFFICIENT', () => {
    const angles = anglesOf(box);
    expect(angles.length).toBe(12);
    // ⚠️ 4 PLACES AND NOT 6, AND THE REASON IS THE STORAGE RATHER THAN THE MATHEMATICS.
    // `edgeAnglesOf` returns a `Float32Array`, so an exact π/2 comes back as 90.0000025°.
    // Asserting 6 places here would be asserting that the answer is a float64, which it is
    // deliberately not — 32,256 edges is the size this has to hold.
    for (const a of angles) expect(deg(a)).toBeCloseTo(90, 4);
    // Deliberately recorded: the interior dihedral of a cube edge is also 90°, so this row
    // cannot distinguish the two definitions. Row 5 is the one that can.
  });

  it('5 — 🔑 A FINER SPHERE IS FLATTER — the interior dihedral would run the other way', () => {
    const measured = (
      [
        [8, 6],
        [16, 8],
        [32, 16],
        [64, 32],
      ] as const
    ).map(([segments, rings]) => {
      const angles = anglesOf(sphereGeometryRef(1, segments, rings, null));
      return Math.max(...Array.from(angles).map(deg));
    });

    // Strictly decreasing, and roughly halving as the segment count doubles.
    for (let i = 1; i < measured.length; i++)
      expect(measured[i], `${i}: flatter than the step before`).toBeLessThan(measured[i - 1]);
    expect(measured[0]).toBeCloseTo(43.61, 1);
    expect(measured[3]).toBeCloseTo(5.63, 1);

    // 🔴 THE FALSIFICATION, STATED AS AN ASSERTION. Under the interior-dihedral reading every one
    // of these would exceed 90° and climb toward 180 as the mesh refines. They fall toward 0.
    for (const m of measured) expect(m).toBeLessThan(90);
  });

  it('6 — a flat pair reads ZERO, which is the reading a dihedral cannot produce', () => {
    // The sphere's finest ring pairs are nearly coplanar; at 64x32 the flattest edge is within a
    // degree of zero. A dihedral would put its flattest edge within a degree of 180.
    const angles = anglesOf(sphereGeometryRef(1, 64, 32, null));
    const nonzero = Array.from(angles).filter((a) => a > 0);
    expect(Math.min(...nonzero.map(deg))).toBeLessThan(1);
  });
});

describe('#800 — composition, and the three different zeros', () => {
  it('7 — array and mirror repeat the source’s angles rather than inventing any', () => {
    for (const [name, ref, edges] of [
      ['array x3', arrayGeometryRef(box, 3, [2, 0, 0]), 36],
      ['mirror', mirrorGeometryRef(box, 'x', 1), 24],
      // 🔴 AT OFFSET 0 THE TWO COPIES COINCIDE IN SPACE. A positional weld would fuse them and
      // report 12; the COMPOSED weld (#754) keeps them distinct, so this row is also a detector
      // for the weld road silently reverting.
      ['mirror at offset 0', mirrorGeometryRef(box, 'x', 0), 24],
    ] as const) {
      const angles = anglesOf(ref);
      expect(angles.length, `${name} edges`).toBe(edges);
      for (const a of angles) expect(deg(a), `${name} stays 90°`).toBeCloseTo(90, 4);
    }
  });

  it('8 — a SUBSET is open, so its boundary edges read zero and its interior ones do not', () => {
    const ref = subsetGeometryRef(box, '0-2', true);
    const angles = anglesOf(ref);
    const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
    expect(angles.length).toBe(10);

    const boundary = adjacency.faces.filter((fs) => fs.length === 1).length;
    const manifold = adjacency.faces.filter((fs) => fs.length === 2).length;
    expect([boundary, manifold], 'three kept faces: 8 boundary edges, 2 interior').toEqual([8, 2]);

    for (let e = 0; e < angles.length; e++) {
      if (adjacency.faces[e].length === 1) expect(angles[e], `edge ${e} boundary`).toBe(0);
      else expect(deg(angles[e]), `edge ${e} interior`).toBeCloseTo(90, 4);
    }
    // 🔑 The angle alone CANNOT tell a boundary edge from a flat one — both are 0. The adjacency
    // is the only thing that can, which is why it is exported rather than kept private.
  });

  it('9 — the refusals are the edge walk’s own, propagated and not re-minted', () => {
    for (const ref of [bakedRef, gltfRef, arrayGeometryRef(bakedRef, 2, [1, 0, 0])]) {
      expect(edgeFaceAdjacencyOf(ref.descriptor), `${ref.key} adjacency`).toBeNull();
      const geometry = getForRead(ref);
      if (geometry !== undefined && geometry !== null)
        expect(edgeAnglesOf(ref, geometry), `${ref.key} angles`).toBeNull();
    }
  });

  it('10 — every face of a closed mesh gets a normal, and a closed mesh has no boundary', () => {
    for (const ref of [box, sphere, arrayGeometryRef(box, 3, [2, 0, 0])]) {
      const normals = builtFaceNormals(ref, getForRead(ref)!)!;
      expect(normals.length, `${ref.key} one normal per face`).toBeGreaterThan(0);
      for (const n of normals) {
        expect(n, `${ref.key} — a closed mesh has no degenerate face`).not.toBeNull();
        expect(Math.hypot(n![0], n![1], n![2]), 'unit').toBeCloseTo(1, 6);
      }
      const adjacency = edgeFaceAdjacencyOf(ref.descriptor)!;
      for (const fs of adjacency.faces)
        expect(fs.length, `${ref.key} closed — every edge has exactly 2 faces`).toBe(2);
    }
  });
});

describe('#800 — what this population CANNOT reach, stated rather than left implicit', () => {
  it('11 — NON-MANIFOLD IS UNCONSTRUCTIBLE HERE, and this is the detector for that changing', () => {
    // 🔴 THIS ROW EXISTS BECAUSE A FALSIFICATION FAILED TO RED. `edgeAnglesOf` answers zero for
    // any edge without exactly two faces, and the non-manifold half of that rule is asserted
    // NOWHERE ELSE in this file — every descriptor a `box`/`sphere` and its array/mirror/subset
    // can build is manifold or open, never branching. So the rule is correct, untested, and
    // would stay untested silently.
    //
    // Rather than leave the claim vacuous or fake a fixture the substrate cannot produce, the
    // ABSENCE is asserted. The day an importer or an operator yields an edge with three faces,
    // this reds and names the row that then has to be written — which is the same discipline
    // `componentCountOf` uses for a domain no operator can name yet.
    let branching = 0;
    let boundary = 0;
    let manifold = 0;
    for (const ref of SYNC_BUILDABLE) {
      for (const fs of edgeFaceAdjacencyOf(ref.descriptor)!.faces) {
        if (fs.length > 2) branching++;
        else if (fs.length === 1) boundary++;
        else manifold++;
      }
    }
    expect(branching, 'a non-manifold edge — none is constructible from this substrate').toBe(0);
    // The other two are asserted as counts so this row cannot pass by examining nothing, and
    // they sum to row 1's independently measured 1696 — two derivations of one denominator.
    expect([boundary, manifold], 'boundary / manifold edges in the population').toEqual([54, 1642]);
    expect(boundary + manifold, 'agrees with row 1 total').toBe(1696);
  });
});

// ── #848 — WHAT AN ANGLE-DERIVED SELECTION MAY BE CACHED ON ──────────────────────────────
//
// Limit Method = Angle (#847) picks which edges are chamfered by reading BUILT positions, and
// that choice sets the bevel's output counts. So unlike `meet` and `slide` — which name a rule
// and let the builder evaluate it — it cannot be deferred: the counts depend on it. It resolves
// upstream and reaches the layout as a resolved set, which is what the reference does too
// (`MOD_bevel.cc:193-203` tags edges; `:238` then calls a bevel whose 24 parameters carry no
// angle).
//
// That leaves the cache key. The instinct is that a position-derived selection cannot be keyed
// on its PARAMETER, because positions might move under a fixed key. Measured, that is FALSE
// here, and these two rows are the measurement: together they say
// `same key ⇒ same positions ⇒ same angle-derived selection`, which is what lets
// `${source.key}|${scope}|${angleLimit}` name exactly one selection.
//
// 🔴 THE SECOND HALF DECAYS SILENTLY, AND `edgeIdentity.ts:411` ALREADY NAMES THE DIRECTION:
// *"non-manifold ... nothing in this project builds today but a `gltf` import could."* The day
// the edge walk answers for a descriptor whose buffer lives outside it, half 2 evaporates and
// the caching decision is wrong with nothing to say so.
//
// ⚠️ WHAT CATCHES WHAT — three detectors, and only the third is new.
//   - A NEW KIND ARRIVING is already caught in PRODUCTION: `weldedPolygonsOf` closes its switch
//     with `const unreachable: never = descriptor` (`edgeIdentity.ts:287-288`), which the CI
//     typecheck does see. Rebuilding that here would add rows and no information.
//   - A `never` closes "did you decide?", never "decided correctly?" — so it cannot catch a new
//     kind ROUTED TO THE ACCEPTING BRANCH while its positions live outside the descriptor.
//   - Row 13's map is keyed by `GeometryDescriptor['kind']`, so a new kind is a missing property
//     and a TYPE error. 🔴 `npm run typecheck` cannot see this file (`tsconfig.app.json` excludes
//     tests) and vitest does not typecheck, so that error surfaces only in the changed-file tsc
//     sweep. It is a real detector, but a manual one — stated plainly rather than relied on.

describe('#848 — the premise the angle-limit cache key rests on', () => {
  it('12 — a position-only change moves the key, on every kind that has one', () => {
    // Each pair differs ONLY in a parameter that moves positions and leaves topology alone.
    // `subset` is absent deliberately: it has no position parameter — its scope changes which
    // faces survive, which is topology. Row 13 covers that it is keyed at all.
    const pairs: readonly (readonly [string, GeometryRef, GeometryRef])[] = [
      ['box size', box, boxGeometryRef([1, 1, 2], null)],
      ['sphere radius', sphere, sphereGeometryRef(2, 8, 6, null)],
      ['array offset', arrayGeometryRef(box, 3, [1, 0, 0]), arrayGeometryRef(box, 3, [2, 0, 0])],
      ['mirror offset', mirrorGeometryRef(box, 'x', 0), mirrorGeometryRef(box, 'x', 1)],
      ['bevel amount', bevelGeometryRef(box, 0.1), bevelGeometryRef(box, 0.2)],
    ];
    // A denominator, so a row that examined nothing cannot read like one that passed.
    expect(pairs.length, 'position-only pairs examined').toBe(5);

    for (const [name, a, b] of pairs) {
      // 🔑 OBSERVE THAT THE GEOMETRY ACTUALLY MOVED FIRST. Without this the row would pass on
      // two keys that merely spell differently, and would go on passing if a "position
      // parameter" silently stopped moving anything — the case that makes the premise vacuous
      // rather than false, and the one a key-only comparison cannot see.
      const pa = getForRead(a)!.getAttribute('position').array;
      const pb = getForRead(b)!.getAttribute('position').array;
      const moved = pa.length !== pb.length || Array.from(pa).some((v, i) => v !== pb[i]);
      expect(moved, `${name} — the variant must actually move geometry`).toBe(true);

      expect(
        a.key === b.key,
        `${name}: two geometries with different positions share the key '${a.key}'. An angle-limit cache keyed on the angle PARAMETER (#847) would serve one of them the other's selection — the key has to become the resolved edge set.`,
      ).toBe(false);
    }
  });

  it('13 — every kind the angle path ACCEPTS is one whose key determines its positions', () => {
    // `keyed` = positions are a function of parameters the mint site folds into the key
    // (`modifierGeometry.ts`). `outside` = the buffer lives beyond the descriptor, so no key
    // over the descriptor can determine it.
    //
    // Typed as a Record over the kind union on purpose: adding a kind without classifying it
    // here is a missing-property type error. See the header for which detector sees that.
    const keying: Record<GeometryDescriptor['kind'], 'keyed' | 'outside'> = {
      box: 'keyed',
      sphere: 'keyed',
      array: 'keyed',
      mirror: 'keyed',
      subset: 'keyed',
      bevel: 'keyed',
      gltf: 'outside',
      baked: 'outside',
    };
    const sample: Record<GeometryDescriptor['kind'], GeometryRef> = {
      box,
      sphere,
      array: arrayGeometryRef(box, 2, [2, 0, 0]),
      mirror: mirrorGeometryRef(box, 'x', 1),
      subset: subsetGeometryRef(box, '0-2', true),
      bevel: bevelGeometryRef(box, 0.1),
      gltf: gltfRef,
      baked: bakedRef,
    };

    const kinds = Object.keys(keying) as GeometryDescriptor['kind'][];
    expect(kinds.length, 'every descriptor kind is classified').toBe(8);

    for (const kind of kinds) {
      const accepted = edgeFaceAdjacencyOf(sample[kind].descriptor) !== null;
      if (keying[kind] === 'keyed') {
        expect(accepted, `${kind} — a keyed kind the angle path should answer for`).toBe(true);
      } else {
        expect(
          accepted,
          `${kind} is now ACCEPTED by the edge walk, and its buffer lives outside the descriptor — so its positions can move under a fixed key. The angle-limit cache key (#847) may no longer be the angle parameter; it has to become the resolved edge set.`,
        ).toBe(false);
      }
    }
  });
});

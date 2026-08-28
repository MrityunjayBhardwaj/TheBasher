// #786 — split rims recovered from the BUILT index agree with the substrate's welded rims.
//
// `polygonLayoutOf` states rims from a descriptor and refuses `array` / `mirror` / `subset`,
// because a copy's rim needs the source's SPLIT vertex count (#777). `builtPolygonRims` answers
// the same question from the built geometry, where that count is not needed at all. This gate is
// what makes the second answer trustworthy enough to stand in for the first.
//
// ── THE GROUND ───────────────────────────────────────────────────────────────────────────
//
// The recovered rim is in SPLIT numbering and `weldedPolygonsOf` is in TOPOLOGICAL ids, so they
// are compared through the same declared weld `cornerCount.gate.test.ts` composes — the two
// derivations share no code: one walks boundary edges of built triangles, the other gathers and
// reverses descriptor-side rims. Agreement at every face of every sync-buildable descriptor is
// two independent routes meeting, which is the same shape of evidence #776 rested on.
//
// 🔴 COMPARED UP TO ROTATION AND NEVER UP TO REVERSAL. A rim and its reverse bound the same face
// and fan to the same unordered triangles; they are different loops and #785 was exactly a
// reversed one shipping green. Row 3 pins that the check can SEE a reversal, so a future change
// that normalises direction away fails here instead of passing quietly.
//
// REF: src/app/builtRims.ts; src/app/edgeIdentity.ts (`weldedPolygonsOf`);
//      src/app/faceCount.ts (`faceArityOf`, `faceCornersOf`, `faceElementStarts`); issues #786, #777.

import { describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { faceArityOf, faceCornersOf, faceElementStarts } from './faceCount';
import { composePointWeld, pointCountOf, weldByPosition } from './pointIdentity';
import type { PointWeld } from './pointIdentity';
import { weldedPolygonsOf } from './edgeIdentity';
import { polygonLayoutOf } from './polygonLayout';
import { getForRead } from './geometryRegistry';
import { alignedSplitRims, builtPolygonRims, composedWeldOf } from './builtRims';

const box = boxGeometryRef([1, 1, 1], null);
const sphere = sphereGeometryRef(1, 8, 6, null);

/** The same population `cornerCount.gate.test.ts` runs — every sync-buildable descriptor. */
const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4], null),
  sphere,
  sphereGeometryRef(1, 32, 16, null),
  sphereGeometryRef(1, 1, 1, null),
  sphereGeometryRef(0.5, 3, 2, null),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphere, 2, [0, 3, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(sphere, 'x', 1),
  mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0),
  mirrorGeometryRef(mirrorGeometryRef(box, 'x', 1), 'y', 1),
  subsetGeometryRef(box, '0', true),
  subsetGeometryRef(box, '0-2', true),
  subsetGeometryRef(box, '0-2', false),
  subsetGeometryRef(sphere, '0-9', true),
  arrayGeometryRef(box, 3, [2, 0, 0], '0-2'),
  arrayGeometryRef(box, 3, [2, 0, 0], '0'),
  arrayGeometryRef(box, 4, [2, 0, 0], '1-2'),
  mirrorGeometryRef(box, 'x', 1, '0-2'),
  mirrorGeometryRef(box, 'x', 1, '0'),
  arrayGeometryRef(sphere, 2, [0, 3, 0], '0-9'),
];

/** The identity the SUBSTRATE declares — composed for derived kinds, not re-welded (#754). */
function declaredWeld(ref: GeometryRef): PointWeld {
  const d = ref.descriptor;
  if (d.kind !== 'array' && d.kind !== 'mirror' && d.kind !== 'subset')
    return weldByPosition(getForRead(ref)!);
  const merged = pointCountOf(d) as { kind: string; count: number };
  const src = pointCountOf(d.source.descriptor) as { kind: string; count: number };
  return composePointWeld(declaredWeld(d.source), merged.count / src.count);
}

/** A cyclic list normalised by ROTATION ONLY — never by reversal. */
function rotationKey(xs: readonly number[]): string {
  const n = xs.length;
  let best: string | null = null;
  for (let s = 0; s < n; s++) {
    let k = '';
    for (let i = 0; i < n; i++) k += `${xs[(s + i) % n]},`;
    if (best === null || k < best) best = k;
  }
  return best ?? '';
}

function rimsOf(ref: GeometryRef): readonly (readonly number[])[] {
  const arity = faceArityOf(ref.descriptor)!;
  const rims = builtPolygonRims(getForRead(ref)!, arity, faceElementStarts(arity));
  expect(rims, 'built rims').not.toBeNull();
  return rims!;
}

describe('#786 — split rims read off the built index, for the kinds a descriptor refuses', () => {
  it('1 — every face of every sync-buildable descriptor recovers a rim, one per face', () => {
    for (const ref of SYNC_BUILDABLE) {
      const arity = faceArityOf(ref.descriptor)!;
      const rims = rimsOf(ref);
      expect(rims.length, `${ref.descriptor.kind} face count`).toBe(arity.length);
    }
  });

  it('2 — a recovered rim is as long as the face has corners', () => {
    let faces = 0;
    for (const ref of SYNC_BUILDABLE) {
      const corners = faceCornersOf(ref.descriptor)!;
      const rims = rimsOf(ref);
      for (let f = 0; f < corners.length; f++) {
        expect(rims[f].length, `${ref.descriptor.kind} face ${f} rim length`).toBe(corners[f]);
        faces++;
      }
    }
    // The denominator, asserted — a population that silently shrank would otherwise pass.
    expect(faces).toBe(977);
  });

  it('3 — recovered rims equal the welded rims through the declared weld, winding and all', () => {
    let compared = 0;
    for (const ref of SYNC_BUILDABLE) {
      const welded = weldedPolygonsOf(ref.descriptor)!;
      const weld = declaredWeld(ref);
      const rims = rimsOf(ref);
      for (let f = 0; f < welded.length; f++) {
        const topological = rims[f].map((v) => weld.map[v]);
        expect(rotationKey(topological), `${ref.descriptor.kind} face ${f}`).toBe(
          rotationKey(welded[f]),
        );
        compared++;
      }
    }
    expect(compared).toBe(977);
  });

  it('3b — NON-VACUOUS: the comparison in row 3 can see a reversal', () => {
    // If it could not, #785 would have passed it. Reversing one rim of a quad-faced descriptor
    // must break the key; a triangle is excluded because its reverse IS a rotation of itself.
    const welded = weldedPolygonsOf(box.descriptor)!;
    expect(welded[0].length).toBeGreaterThan(3);
    expect(rotationKey([...welded[0]].reverse())).not.toBe(rotationKey(welded[0]));
  });

  it('4 — the fan rule does NOT describe the emitted triangles, which is why the walk exists', () => {
    // The first draft read triangle `t` as `(rim[0], rim[t+1], rim[t+2])`. Measured on a box that
    // is wrong for every face, and `cornerCount.gate.test.ts` cannot see it — it compares the
    // triangles of a face as a SET. This row keeps that finding from being re-lost.
    const arity = faceArityOf(box.descriptor)!;
    const starts = faceElementStarts(arity);
    const index = getForRead(box)!.getIndex()!;
    const rims = rimsOf(box);
    let facesWhereFanRuleHolds = 0;
    for (let f = 0; f < arity.length; f++) {
      let holds = true;
      for (let t = 0; t < arity[f]; t++) {
        const i = (starts[f] + t) * 3;
        if (index.getX(i) !== rims[f][0] || index.getX(i + 1) !== rims[f][t + 1]) holds = false;
      }
      if (holds) facesWhereFanRuleHolds++;
    }
    expect(facesWhereFanRuleHolds, 'a box, if the emitted order were a fan from rim[0]').toBe(0);
  });

  it('5 — the composed weld matches the one the gates derive by hand, at every descriptor', () => {
    for (const ref of SYNC_BUILDABLE) {
      const production = composedWeldOf(ref);
      expect(production, `${ref.descriptor.kind} composed weld`).not.toBeNull();
      expect(Array.from(production!.map), `${ref.descriptor.kind} weld map`).toEqual(
        Array.from(declaredWeld(ref).map),
      );
    }
  });

  it('6 — aligned split rims reproduce the welded rims EXACTLY, not merely up to rotation', () => {
    let compared = 0;
    for (const ref of SYNC_BUILDABLE) {
      const welded = weldedPolygonsOf(ref.descriptor)!;
      const weld = composedWeldOf(ref)!;
      const aligned = alignedSplitRims(ref, getForRead(ref)!);
      expect(aligned, `${ref.descriptor.kind} aligned rims`).not.toBeNull();
      for (let f = 0; f < welded.length; f++) {
        expect(
          aligned![f].map((v) => weld.map[v]),
          `${ref.descriptor.kind} face ${f}`,
        ).toEqual([...welded[f]]);
        compared++;
      }
    }
    expect(compared).toBe(977);
  });

  it('6b — NON-VACUOUS: alignment refuses a rim that is genuinely a different loop', () => {
    // Row 6 would be satisfiable by an alignment that returned anything at all, so the refusal
    // has to be shown to fire. A rim whose welded target has one corner replaced cannot be
    // reached by any rotation of the recovered rim.
    const weld = composedWeldOf(box)!;
    const rims = rimsOf(box);
    const target = rims[0].map((v) => weld.map[v]);
    const corrupted = [...target];
    corrupted[1] = corrupted[1] === 0 ? 1 : 0;
    let anyRotationMatches = false;
    for (let s = 0; s < target.length; s++) {
      let all = true;
      for (let i = 0; i < target.length; i++)
        if (weld.map[rims[0][(s + i) % target.length]] !== corrupted[i]) all = false;
      if (all) anyRotationMatches = true;
    }
    expect(anyRotationMatches).toBe(false);
  });

  it('7 — where the descriptor DOES state rims, the built road recovers the same ones', () => {
    // The two roads must not be two answers. `polygonLayoutOf` lays out `box` and `sphere` from
    // the descriptor; this recovers them from the buffer. Agreement in SPLIT numbering, corner
    // for corner, is what lets one function serve every kind instead of a primitive road and a
    // derived road that can drift.
    let checked = 0;
    for (const ref of SYNC_BUILDABLE) {
      const layout = polygonLayoutOf(ref.descriptor);
      if (layout.kind !== 'laid-out') continue;
      const aligned = alignedSplitRims(ref, getForRead(ref)!)!;
      expect(aligned.length, `${ref.descriptor.kind} face count`).toBe(layout.polygons.length);
      for (let f = 0; f < aligned.length; f++) {
        expect([...aligned[f]], `${ref.descriptor.kind} face ${f}`).toEqual([
          ...layout.polygons[f],
        ]);
        checked++;
      }
    }
    expect(checked, 'primitive faces compared').toBeGreaterThan(0);
  });
});

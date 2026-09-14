// #712 — `keptSourcePoints`: which of its source's topological points a subset actually
// references, and the ordering decision that makes the compaction derivable.
//
// ── WHAT THESE ROWS PIN ───────────────────────────────────────────────────────────────
//
//   1  the derived list matches what a COMPACTED build would weld to — checked against the
//      built geometry's referenced positions, through PRODUCTION's `weldByPosition` rather
//      than a second spelling of it (the first draft of this probe hashed the coordinates
//      itself and split a sphere's seam on negative zero, which is the same "one claim
//      spelled twice" failure the subject is about)
//   2  it composes — a subset over an array, a mirror and another subset
//   3  the answer is NOT trivially the source's whole point set, so a row that agreed by
//      returning everything would red
//   4  the ordering decision is recorded as a falsifiable row: ascending source-point order
//      and first-surviving-split-appearance order are DIFFERENT, so the build must follow
//      this function rather than filter in place
//   5  a source that holds its buffers elsewhere refuses, and says so by returning `null`
//
// REF: src/app/pointIdentity.ts (`keptSourcePoints`, `pointCountOf`, `tiledPointOrder`);
//      src/app/edgeIdentity.ts (`weldedPolygonsOf`); issue #712.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GeometryDescriptor, GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
  subsetGeometryRef,
} from './modifierGeometry';
import { keptSourcePoints, pointCountOf, weldByPosition } from './pointIdentity';
import { faceArityOf, faceElementStarts } from './faceCount';
import { getForRead } from './geometryRegistry';
import { __clearGltfCloneRegistryForTests, registerGltfClone } from './asset/gltfCloneRegistry';

const box = boxGeometryRef([1, 1, 1], null);
const s8 = sphereGeometryRef(1, 8, 6, null);
const s32 = sphereGeometryRef(1, 32, 16, null);

function subsetOf(source: GeometryRef, scope: string, keep = true) {
  const ref = subsetGeometryRef(source, scope, keep);
  return ref.descriptor as Extract<GeometryDescriptor, { kind: 'subset' }>;
}

/** What a compacted build would weld to: the distinct topological points its index names. */
function referencedPoints(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  if (idx === null) throw new Error('non-indexed');
  const { map } = weldByPosition(g);
  const distinct = new Set<number>();
  for (let i = 0; i < idx.count; i++) distinct.add(map[idx.getX(i)]);
  return distinct.size;
}

describe('#712 — the derived list matches a compacted build', () => {
  const rows: Array<[string, GeometryRef, string, boolean]> = [
    ['box keep 0', box, '0', true],
    ['box keep 0-1', box, '0-1', true],
    ['box keep 0-4', box, '0-4', true],
    ['box drop 0', box, '0', false],
    ['sphere 8x6 keep 0', s8, '0', true],
    ['sphere 8x6 keep 0-7', s8, '0-7', true],
    ['sphere 8x6 keep 10-20', s8, '10-20', true],
    ['sphere 8x6 drop 0-7', s8, '0-7', false],
    ['sphere 32x16 keep 0', s32, '0', true],
    ['sphere 32x16 keep 0-99', s32, '0-99', true],
    ['sphere 32x16 drop 0-99', s32, '0-99', false],
    ['subset over array x3', arrayGeometryRef(box, 3, [2, 0, 0], null), '0-5', true],
    ['subset over array x3, one face', arrayGeometryRef(box, 3, [2, 0, 0], null), '0', true],
    ['subset over mirror', mirrorGeometryRef(box, 'x', 2, null), '0-3', true],
    ['subset over subset', subsetGeometryRef(box, '0-3', true), '0', true],
  ];

  it.each(rows)('%s', (_label, source, scope, keep) => {
    const derived = keptSourcePoints(subsetOf(source, scope, keep));
    expect(derived).not.toBeNull();
    const built = getForRead(subsetGeometryRef(source, scope, keep));
    expect(built).not.toBeNull();
    expect(derived!.length).toBe(referencedPoints(built!));
  });

  it('is not trivially the whole source — the narrow scopes really do narrow', () => {
    // Without this row every assertion above would pass for a function that returned the
    // source's entire point set, because the uncompacted build carries exactly that.
    const wholeBox = pointCountOf(box.descriptor);
    expect(wholeBox.kind).toBe('counted');
    expect(keptSourcePoints(subsetOf(box, '0'))!.length).toBe(4);
    expect(keptSourcePoints(subsetOf(box, '0'))!.length).toBeLessThan(8);
    // A sphere keeping one face references 3 of its 482 points.
    expect(keptSourcePoints(subsetOf(s32, '0'))!.length).toBe(3);
    // And keeping everything really does return everything.
    expect(keptSourcePoints(subsetOf(box, '0-5'))!.length).toBe(8);
  });

  it('shares points between adjacent faces rather than summing them', () => {
    // Two faces of a box share an edge, so the union is 8 and not 4 + 4.
    expect(keptSourcePoints(subsetOf(box, '0'))!.length).toBe(4);
    expect(keptSourcePoints(subsetOf(box, '0-1'))!.length).toBe(8);
  });

  it('is ascending, and that is a DECISION — first-appearance order differs', () => {
    // The row that records why the build must follow this function instead of filtering its
    // source's buffer in place. If these two ever coincide the decision stops costing
    // anything, and this row is where that would show up.
    const derived = keptSourcePoints(subsetOf(box, '0'))!;
    expect([...derived]).toEqual([...derived].sort((a, b) => a - b));

    // First surviving split appearance, walked the way `faceSubset` walks.
    const geom = getForRead(box)!;
    const index = geom.getIndex()!;
    const { map } = weldByPosition(geom);
    const arity = faceArityOf(box.descriptor)!;
    const starts = faceElementStarts(arity);
    const appearance: number[] = [];
    const seen = new Set<number>();
    for (let t = starts[0]; t < starts[0] + arity[0]; t++) {
      for (const c of [0, 1, 2]) {
        const w = map[index.getX(t * 3 + c)];
        if (seen.has(w)) continue;
        seen.add(w);
        appearance.push(w);
      }
    }
    expect(derived).toEqual([0, 1, 2, 3]);
    expect(appearance).toEqual([0, 2, 1, 3]);
    expect(appearance).not.toEqual(derived);
  });

  it('refuses a source whose buffers live elsewhere', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.name = 'Cube';
    const group = new THREE.Group();
    group.add(mesh);
    registerGltfClone('u/kept-points.gltf', group);
    try {
      const descriptor: GeometryDescriptor = {
        kind: 'gltf',
        assetRef: 'u/kept-points.gltf',
        childName: 'Cube',
        faceCount: 12,
      };
      const imported: GeometryRef = { key: `k|${JSON.stringify(descriptor)}`, descriptor };
      // A clone IS mounted, so this null is the descriptor's escape hatch and not an
      // artefact of an empty registry — the control that #712's own measurement lacked.
      expect(getForRead(imported)).not.toBeNull();
      expect(keptSourcePoints(subsetOf(imported, '0'))).toBeNull();
    } finally {
      __clearGltfCloneRegistryForTests();
    }
  });
});

// #633 (ns-1) — `faceCountOf` agrees with what the geometry actually tessellates to.
//
// The count is derived from the descriptor because the mint happens inside a node's
// `evaluate()`, which is pure and synchronous and must not build a `BufferGeometry`. That
// makes it a SECOND SPELLING of three.js's tessellation, and a second spelling that agrees
// today passes every behavioural test until the day it stops agreeing — at which point a
// face-domain attribute is silently the wrong length for its geometry.
//
// So this gate does the one thing that closes it: builds each sync-buildable descriptor
// through the registry and compares the built triangle count with the derived one. Included
// deliberately are the CLAMP edges, where three.js raises a sphere's segments to its own
// minimum without saying so — the arm most likely to drift, and the one a well-chosen
// "typical" fixture would never exercise.
//
// The two non-derivable kinds are censused exactly rather than left implicit: an escape
// hatch that is not counted is an escape hatch that widens.
//
// REF: src/app/faceCount.ts (`faceCountOf` — the leaf it now lives in);
//      src/app/geometryRegistry.ts (the build); issues #633, #395, #638.

import { describe, expect, it } from 'vitest';
import type { GeometryRef } from '../nodes/types';
import {
  arrayGeometryRef,
  boxGeometryRef,
  mirrorGeometryRef,
  sphereGeometryRef,
} from './modifierGeometry';
import { faceCountOf } from './faceCount';
import { getForRead } from './geometryRegistry';

/** Triangles in the BUILT geometry — the ground truth this gate compares against. */
function builtFaceCount(ref: GeometryRef): number {
  const geom = getForRead(ref);
  expect(geom, `registry could not build ${ref.key}`).not.toBeNull();
  const index = geom!.getIndex();
  return index ? index.count / 3 : geom!.getAttribute('position').count / 3;
}

const box = boxGeometryRef([1, 1, 1]);

const SYNC_BUILDABLE: readonly GeometryRef[] = [
  box,
  boxGeometryRef([2, 3, 4]),
  sphereGeometryRef(1, 32, 16),
  sphereGeometryRef(1, 8, 4),
  // Clamp edges: three.js raises width to 3 and height to 2 without reporting it.
  sphereGeometryRef(1, 1, 1),
  sphereGeometryRef(0.5, 3, 2),
  arrayGeometryRef(box, 3, [2, 0, 0]),
  arrayGeometryRef(sphereGeometryRef(1, 8, 4), 2, [0, 2, 0]),
  mirrorGeometryRef(box, 'x', 1),
  mirrorGeometryRef(arrayGeometryRef(box, 2, [2, 0, 0]), 'z', 0),
];

describe('#633 faceCountOf agrees with the built geometry', () => {
  it.each(SYNC_BUILDABLE.map((ref) => [ref.key, ref] as const))(
    'derives the built triangle count for %s',
    (_key, ref) => {
      expect(faceCountOf(ref.descriptor)).toBe(builtFaceCount(ref));
    },
  );

  it('counts the not-derivable kinds EXACTLY', () => {
    const notDerivable = (
      [
        { kind: 'gltf', assetRef: 'asset', childName: 'child' },
        { kind: 'baked', hash: 'deadbeef', vertexCount: 24 },
      ] as const
    ).filter((descriptor) => faceCountOf(descriptor) === null);

    expect(notDerivable.map((d) => d.kind)).toEqual(['gltf', 'baked']);
  });

  it('propagates non-derivability through a modifier rather than guessing', () => {
    const gltf: GeometryRef = {
      key: 'gltf|asset|child',
      kind: 'gltf',
      descriptor: { kind: 'gltf', assetRef: 'asset', childName: 'child' },
    };
    expect(faceCountOf(arrayGeometryRef(gltf, 3, [1, 0, 0]).descriptor)).toBeNull();
    expect(faceCountOf(mirrorGeometryRef(gltf, 'x', 0).descriptor)).toBeNull();
  });
});

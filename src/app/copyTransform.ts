// #723 — THE MATRIX A MERGING DESCRIPTOR BUILDS EACH COPY WITH. ONE STATEMENT, TWO READERS.
//
// `buildArray` and `buildMirror` each construct this matrix to place a copy's GEOMETRY. The
// attribute gather needs the identical matrix to transform a copy's directional ATTRIBUTES,
// and two spellings of "where does copy i go" is exactly the drift this codebase keeps
// finding: the geometry would move one way and its normals another, and the mesh would draw
// plausibly and be wrong.
//
// So the arithmetic lives here, imports nothing but `three` and a type, and both roads read it.
//
// REF: src/app/geometryRegistry.ts (`buildArray`, `buildMirror` — the geometry readers);
//      src/nodes/meshAttributes.ts (the attribute reader); issue #723.

import { Matrix4 } from 'three';
import type { GeometryDescriptor } from '../nodes/types';

/**
 * The matrix copy `copy` of `descriptor` is built with, or `null` when the kind does not
 * place copies by a matrix at all.
 *
 * Copy 0 of a mirror is the PRESERVED original and takes the identity; copy 1 is the
 * reflection. Copy `i` of an array takes `offset * i`, so copy 0 is likewise the identity.
 * Both match the builders exactly, which is the point of the module.
 */
export function copyMatrixOf(descriptor: GeometryDescriptor, copy: number): Matrix4 | null {
  if (descriptor.kind === 'array') {
    return new Matrix4().makeTranslation(
      descriptor.offset[0] * copy,
      descriptor.offset[1] * copy,
      descriptor.offset[2] * copy,
    );
  }
  if (descriptor.kind === 'mirror') {
    if (copy === 0) return new Matrix4();
    return mirrorMatrixOf(descriptor.axis, descriptor.offset);
  }
  return null;
}

/**
 * Reflection across the plane perpendicular to `axis` at `offset` along it:
 * `p' = 2·offset − p` on that axis — a scale of −1 plus a translation of `2·offset`.
 *
 * 🔴 THE TRANSLATION IS THE HALF THAT MAKES `position` AND `vector` DIFFERENT HERE. A pure
 * reflection would leave the two indistinguishable under this operator; the `2·offset` term
 * means a position must follow it and a direction must not, which is observable with any
 * non-zero offset.
 */
export function mirrorMatrixOf(axis: 'x' | 'y' | 'z', offset: number): Matrix4 {
  const m = new Matrix4().makeScale(
    axis === 'x' ? -1 : 1,
    axis === 'y' ? -1 : 1,
    axis === 'z' ? -1 : 1,
  );
  const t = 2 * offset;
  m.setPosition(axis === 'x' ? t : 0, axis === 'y' ? t : 0, axis === 'z' ? t : 0);
  return m;
}

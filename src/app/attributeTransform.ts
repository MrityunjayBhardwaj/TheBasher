// #723 — WHICH TRANSFORM TYPES THIS BUILD CAN HONOUR UNDER A MATRIX, AND HOW.
//
// `TRANSFORM_TYPES` declares the vocabulary; this module says what each member MEANS when a
// matrix is applied, and refuses by name the two nothing can answer for yet. The dispatch is
// closed by a `never`, so adding a seventh member stops this compiling until someone decides
// its rule — which is the whole reason the vocabulary and its honouring are separate files.
//
// ── THE NORMAL RULE IS GROUNDED IN LIBRARY SOURCE, NOT INFERRED FROM THE REFERENCE ────────
//
// `ref/houdini/SOP.md:24` names a distinct "Normal" type but does NOT print the matrix, and
// records the inverse-transpose as UNVERIFIED from that page. It does not need to be verified
// from there: three implements it directly —
//
//     Matrix3.getNormalMatrix( m ) { return this.setFromMatrix4( m ).invert().transpose(); }
//         node_modules/three/src/math/Matrix3.js:201
//
// — and `BufferGeometry.applyMatrix4` already applies exactly that to a geometry's BUILT-IN
// normals (`node_modules/three/src/core/BufferGeometry.js:145-147`). So honouring `normal`
// here is not a new rule invented for the store road; it is the store road stopping to
// disagree with the buffer road about the same datum.
//
// REF: node_modules/three/src/math/Matrix3.js:201; node_modules/three/src/core/BufferGeometry.js:145-147;
//      ref/houdini/SOP.md:24; src/nodes/attributes.ts (`TRANSFORM_TYPES`); issue #723.

import { Matrix3, Matrix4, Vector3 } from 'three';
import type { TransformType } from '../nodes/attributes';

/** What this build can do with a declared transform type under a matrix. */
export type TransformRule =
  /** Values ride through untouched — no matrix is applied. */
  | { readonly kind: 'identity' }
  /** Each 3-component element is mapped by {@link TransformRule.apply}. */
  | { readonly kind: 'mapped'; readonly apply: (v: Vector3, m: Matrix4) => Vector3 }
  /** Nothing here can answer for this type yet; the reason is the message. */
  | { readonly kind: 'refused'; readonly why: string };

/**
 * The rule for `type`, or the reason there is none.
 *
 * `undefined` — an UNCLASSIFIED attribute — is refused rather than treated as `'none'`. The
 * two are different claims: `'none'` is a producer saying a matrix must not touch this, and
 * absent is a producer that has not said. Reading silence as "do nothing" is how a normal
 * arrives on a reflected half pointing the wrong way with nobody warned.
 */
export function transformRuleFor(type: TransformType | undefined): TransformRule {
  if (type === undefined)
    return {
      kind: 'refused',
      why:
        'the attribute declares no transform type, and a value that has not said whether it ' +
        'is a position, a direction, a normal or a colour cannot be transformed correctly',
    };

  switch (type) {
    case 'none':
      return { kind: 'identity' };

    case 'position':
      // The FULL matrix, translation included.
      return { kind: 'mapped', apply: (v, m) => v.applyMatrix4(m) };

    case 'vector':
      // The linear part only. `transformDirection` applies the upper-left 3x3 — and then
      // NORMALISES, which is wrong for a velocity whose magnitude is its speed, so the
      // linear part is applied by hand instead.
      return {
        kind: 'mapped',
        apply: (v, m) => v.applyMatrix3(new Matrix3().setFromMatrix4(m)),
      };

    case 'normal':
      // The inverse-transpose of the linear part — the same matrix three applies to a
      // geometry's own normals, taken from three rather than re-derived here.
      return {
        kind: 'mapped',
        apply: (v, m) => v.applyMatrix3(new Matrix3().getNormalMatrix(m)),
      };

    case 'quaternion':
      return {
        kind: 'refused',
        why:
          'a quaternion transforms as a rotation, and a mirror is improper (determinant -1) ' +
          'so a reflection is not one — what an orientation becomes under it is undecided here',
      };

    case 'matrix':
      return {
        kind: 'refused',
        why: 'a per-element frame has no producer in this build, so its carriage is unwritten',
      };

    default: {
      const unreachable: never = type;
      throw new Error(`transformRuleFor: undeclared transform type ${String(unreachable)}`);
    }
  }
}

// #1381 — three ships MikkTSpace (wasm, inlined) beside its examples but no typings for it. The
// shape below is the module's own exports (`three/examples/jsm/libs/mikktspace.module.js`), the same
// ones `BufferGeometryUtils.computeMikkTSpaceTangents` calls.
declare module 'three/examples/jsm/libs/mikktspace.module.js' {
  /** Resolves once the inlined wasm is instantiated; `generateTangents` throws before that. */
  export const ready: Promise<void>;
  export const isReady: boolean;
  /**
   * One XYZW tangent per corner of a NON-indexed triangle list: `position` and `normal` are three
   * floats per corner, `texcoord` two.
   */
  export function generateTangents(
    position: Float32Array,
    normal: Float32Array,
    texcoord: Float32Array,
  ): Float32Array;
}

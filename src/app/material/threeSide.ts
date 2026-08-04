// threeSide — the one place the IR's `doubleSided` boolean becomes three's `side` enum.
//
// `openpbrToThree` compiles everything else into THREE's vocabulary but deliberately
// leaves this one as a boolean, and says why: that module stays THREE-free, because the
// IR is renderer-agnostic and a second backend (v0.7 TSL) compiles the same IR. So the
// translation has to happen on the renderer side — and there are exactly two renderer
// sides that need it, which is what makes this a shared function rather than a line
// repeated twice:
//
//   - the NATIVE road, where it becomes `PrimitiveMaterialSpec.side` and the registry
//     builds from it (#532);
//   - the glTF road, where `applyOpenpbrScalars` writes it onto an already-cloned
//     imported material.
//
// Two spellings of a two-valued mapping look harmless — they agree today, and the only
// way they can diverge is an inversion. That is precisely the failure that reads as
// correct in review: whichever site is edited, the other keeps the old answer and only
// one road's tests notice.
//
// REF: src/app/material/openpbrToThree.ts (`ThreeMaterialParams.doubleSided` and the
//      THREE-free rule it states), src/app/materialRegistry.ts (`side` on the spec),
//      src/viewport/SceneFromDAG.tsx (`applyOpenpbrScalars`); issues #532, #536.

import * as THREE from 'three';

/** Which faces to render, from the IR's captured `geometry.doubleSided`. */
export function threeSideFor(doubleSided: boolean): THREE.Side {
  return doubleSided ? THREE.DoubleSide : THREE.FrontSide;
}

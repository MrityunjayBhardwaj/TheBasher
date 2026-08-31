// edgeAngleSelection — an angle limit becomes a set of EDGE INDICES. #847, over #800.
//
// ── WHY THIS IS ITS OWN MODULE AND NOT A BRANCH INSIDE THE RESOLVER ──────────────────────
//
// Two reasons, and the second is enforced by a gate rather than by taste.
//
//   1. This is the only place in the scope road that needs BUILT POSITIONS. Everything else
//      about a selection is derived from the descriptor. Keeping the one positional read in
//      one named module is what lets `componentSelection` stay a pure function of its spine
//      and params (see the note on cacheability below).
//   2. `geometryRegistry` has a CLOSED, declared consumer set — `registryDoors.gate.test.ts`
//      reds on an undeclared importer. Holding the door here means ONE narrow module is
//      declared as a `read` consumer, rather than widening the shared resolver's surface.
//
// ── THE SELECTION IS RESOLVED HERE AND STORED AS A LITERAL SET, NOT AS AN ANGLE ──────────
//
// A `GeometryRef`'s descriptor is a REBUILD RECIPE the registry re-reads later, off the
// render road, with no selection and no built geometry in scope (`componentSelection.ts`
// says so where it explains why a resolved selection carries a string at all). So an
// `angleLimit` living in the descriptor could never be resolved at rebuild time. The angle
// is an AUTHORING input; what reaches the descriptor is the set it selected.
//
// This is also what the reference does. Blender's bevel modifier tags edges in a pass that
// completes before the bevel runs — `MOD_bevel.cc:193-203` computes `threshold` once and
// flags each qualifying edge — and then calls `BM_mesh_bevel`, whose 24 parameters carry no
// angle at all (`bmesh_bevel.cc:8239-8262`). The weight limit IS passed through as
// `use_weights`; the angle deliberately is not. We mirror the tag, not the parameter.
//
// ── 🔴 THE BOUNDARY-EDGE TRAP, WHICH IS WHY THE FACE COUNT IS CHECKED AND NOT THE ANGLE ──
//
// `edgeAnglesOf` answers ZERO for three unrelated edges — a FLAT one (coplanar faces), a
// BOUNDARY one (a single face, which every open mesh and every `subset` produces), and a
// NON-MANIFOLD one. It follows Blender in collapsing them, and says so.
//
// So a rule stated as "angle exceeds the limit" is correct, but one stated by INVERTING it,
// or evaluated at a limit of zero, would sweep in every boundary edge on every open mesh —
// silently, because the count would still be plausible and the mesh would still build. The
// reference cannot reach that state: `MOD_bevel.cc:195` calls `BM_edge_loop_pair` and only
// tests the angle when the edge has EXACTLY TWO faces. The manifold check is therefore a
// PRECONDITION of asking the question, not a refinement of the answer, and it is written
// that way below.
//
// REF: src/app/edgeAngle.ts (`edgeAnglesOf` — the angle, and its three zeros);
//      src/app/edgeIdentity.ts (`edgeFaceAdjacencyOf` — the face count that separates them);
//      ref/sources/blender-mesh/MOD_bevel.cc:129, :193-203; issues #847, #800.

import type { GeometryRef } from '../nodes/types';
import { getForRead } from './geometryRegistry';
import { edgeAnglesOf } from './edgeAngle';
import { edgeFaceAdjacencyOf } from './edgeIdentity';

/** The reference's own angular slack, in radians — `MOD_bevel.cc:129`. See its use below. */
const BEVEL_ANGLE_EPSILON = 0.000000175;

/** Selected edge indices, or the named reason no answer could be given. */
export type EdgeAngleVerdict =
  | { readonly kind: 'selected'; readonly edges: readonly number[] }
  | { readonly kind: 'refused'; readonly why: string };

/**
 * Every edge whose dihedral deviation EXCEEDS `limitDegrees`, index-aligned with `edgeSetOf`.
 *
 * `limitDegrees` is degrees because that is this codebase's convention at an authoring
 * boundary (rotation is degrees Euler XYZ, a camera's FOV is degrees); `edgeAnglesOf` answers
 * in radians, so the comparison converts once, here, rather than at each call site.
 *
 * STRICTLY GREATER, matching the reference: Blender compares `dot < cos(angle + eps)`, and a
 * dot below the cosine is an angle above the limit. So an edge exactly AT the limit is not
 * selected, and a limit of 0 selects every non-flat manifold edge rather than everything.
 */
export function edgeIndicesByAngle(ref: GeometryRef, limitDegrees: number): EdgeAngleVerdict {
  const geometry = getForRead(ref);
  if (geometry === null)
    return {
      kind: 'refused',
      why: `'${ref.descriptor.kind}' has no readable built geometry, so no edge angle can be measured — a glTF ref lives in its asset clone, and a baked one behind an async read`,
    };

  const adjacency = edgeFaceAdjacencyOf(ref.descriptor);
  const angles = edgeAnglesOf(ref, geometry);
  if (adjacency === null || angles === null)
    return {
      kind: 'refused',
      why: `the edge walk cannot answer for '${ref.descriptor.kind}', so its edges have no angles to threshold`,
    };

  // 🔴 THE REFERENCE'S OWN EPSILON, AND IT IS LOAD-BEARING RATHER THAN DECORATIVE.
  // `MOD_bevel.cc:129` computes `cosf(bmd->bevel_angle + 0.000000175f)` — the limit nudged UP
  // by ~1.75e-7 radians before the comparison. Without it a limit typed at exactly the angle a
  // mesh actually has selects everything instead of nothing: `edgeAnglesOf` returns a
  // `Float32Array`, so a box's right angle reads back as 90.0000025° and clears a 90° bar.
  // The epsilon (~1e-5°) is an order of magnitude above that error, so the case a user is
  // most likely to type — the exact angle they can see — lands on the intended side.
  const limit = (limitDegrees * Math.PI) / 180 + BEVEL_ANGLE_EPSILON;
  const edges: number[] = [];
  for (let e = 0; e < angles.length; e++) {
    // 🔴 THE MANIFOLD CHECK IS A PRECONDITION, NOT A FILTER ON THE ANSWER. See the header:
    // a boundary edge's angle is 0 for a reason unrelated to flatness, so it must not be
    // compared at all rather than compared and rejected.
    if (adjacency.faces[e].length !== 2) continue;
    if (angles[e] > limit) edges.push(e);
  }
  return { kind: 'selected', edges };
}

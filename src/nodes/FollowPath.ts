// FollowPath — the second constraint (issue #339, the camera-rig headline). It PLACES a
// node (`target`) on a Curve (`curve`) at a keyframeable fraction along the path.
//
// THE BAND SPLIT (and why this node exists at all): Track-To writes a node's ROTATION,
// derived from where it IS. FollowPath writes its POSITION, derived from the path. Two
// operators, two bands, one target — so "fly the camera along this path while staying
// locked on the hero" is just both of them on one object, with no ordering to reason
// about. That is the whole point of the constraint STACK over a bespoke sidecar: the
// second pose operator costs a node, not an architecture.
//
// MODELLED EXACTLY LIKE TrackTo (the species shape — see TrackTo.ts's header for the
// full argument): EDGE-LESS. It names its target and its curve by `{node}` param ref,
// is enumerated from the node table (`nodeConstraints.ts`), and is RESOLVED at the
// scene-resolution seam where world transforms exist. It CANNOT be a pure `evaluate`:
// the path is another object's world geometry, which only exists after composition.
//
// WHY `evalTime` IS A FRACTION OF LENGTH, NOT A SPLINE `t`: the seam
// (`curveSampleSource.ts`) is parameterized by WORLD ARC LENGTH, so equal steps in
// `evalTime` are equal DISTANCES travelled. That is what makes the base motion
// constant-speed — and therefore what makes an F-curve on `evalTime` read as the ease
// the director authored, rather than as the ease plus the curve's own lurching. Eased
// path-speed is not a feature of this node; it falls out of keyframing `evalTime`
// because the seam already did the hard part.
//
// `evalTime` IS RESOLVED THROUGH `resolveEvaluatedParam`, NOT READ RAW — see
// `resolveConstraintPosition` (nodeConstraints.ts). Reading it raw would make it a dead
// number: keyframes and drivers would be silently ignored and the paragraph above would
// be a lie. Track-To never surfaced this because none of its params are ever animated.
//
// DELIBERATELY OUT OF SCOPE (v1): orienting the object along the path TANGENT (Blender's
// "Follow Curve"). The seam already returns the tangent, so it is cheap — but it writes
// the ROTATION band, which would put this node in contention with Track-To and destroy
// the orthogonality that makes the camera rig compose for free. If it lands, it lands as
// an explicit opt-in that a director can see, not as a silent second rotation writer.
//
// REF: issue #339; src/nodes/TrackTo.ts (the template); src/app/nodeConstraints.ts (the
//      enumeration + the position fold); src/app/curveSampleSource.ts (the arc-length
//      seam); src/nodes/Curve.ts.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { FollowPathConstraintValue } from './types';

export const FollowPathParams = z.object({
  name: z.string().default('follow-path'),
  /** The constrained node id whose position this derives (mirrors a channel's `target`).
   *  Empty → inert (enumerated but no node to place). */
  target: z.string().default(''),
  /** The Curve node to follow. Empty / not a Curve → the member is DEGENERATE and
   *  contributes nothing to the fold, exactly as a muted one would. */
  curve: z.string().default(''),
  /** Where along the path, as a fraction of its total ARC LENGTH: 0 = start, 1 = end.
   *  A closed path WRAPS past 1, an open one CLAMPS (the seam's rule — Blender's Cyclic
   *  flag). KEYFRAME THIS: an F-curve here is the path's speed profile, and because the
   *  seam is arc-length parameterized, a linear ramp is genuinely constant speed. */
  evalTime: z.number().default(0),
  /** A constant added to `evalTime` before sampling. Lets several objects ride ONE
   *  animated `evalTime` spread out along the path (the convoy), instead of needing a
   *  separate copy of the animation per object. */
  offset: z.number().default(0),
  /** Bypass — a muted constraint contributes nothing (the constraint stack). */
  mute: z.boolean().default(false),
  /** Position in the target's ordered constraint stack (low → high, bottom → top).
   *  Shared with Track-To: one object has ONE constraint stack, and both operators take
   *  their slot in it. Within the POSITION band the fold is last-writer-wins, so a higher
   *  `order` wins; a Track-To in the same stack writes a different band and never
   *  contends. Mirrors `TrackTo.order` / `ParamDriver.order`. */
  order: z.number().default(0),
});
export type FollowPathParams = z.infer<typeof FollowPathParams>;

export const FollowPathNode: NodeDefinition<FollowPathParams, FollowPathConstraintValue> = {
  type: 'FollowPath',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: FollowPathParams,
  // #421 — `target` is the constrained object (owner → subject). `curve` is a
  // shared path several objects may follow, so deleting the curve leaves the
  // constraint in place with an empty path rather than destroying it.
  idRefs: [
    { path: 'target', shape: 'id', role: 'subject' },
    { path: 'curve', shape: 'id', role: 'argument' },
  ],
  // Edge-less (enumerated + seam-resolved, like TrackTo and a direct channel). The `out`
  // socket exists for introspection; nothing consumes it.
  inputs: {},
  outputs: { out: { type: 'Constraint', cardinality: 'single' } },
  inspectorSections: ['constraint', 'driver'],
  // The path is bound through the general node-ref picker (#341). `shape:'id'` because
  // `curve` is a plain string id (the fold reads it raw); `kind:'curve'` filters the
  // candidates to nodes the arc-length sampler can actually consume (curveSamplerFor
  // resolves) — the exact mirror of TrackTo's `transformable` aim target, one band over.
  // Without this, a Follow-Path renders no field for `curve` and is unbindable by mouse.
  refParams: { curve: { label: 'curve', kind: 'curve', shape: 'id' } },
  evaluate(params): FollowPathConstraintValue {
    return {
      kind: 'Constraint',
      constraintType: 'followPath',
      name: params.name,
      target: params.target,
      curve: params.curve,
      evalTime: params.evalTime,
      offset: params.offset,
      mute: params.mute,
      order: params.order,
    };
  },
};

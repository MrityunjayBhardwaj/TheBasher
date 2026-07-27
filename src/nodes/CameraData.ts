// CameraData — the DATA half of the object↔data split for the two cameras
// (#387, Stage C · C4).
//
// A camera's substance is its LENS — how it projects (perspective vs orthographic),
// its focal length / zoom, its clip planes, and its depth-of-field. Where it sits in
// the world is a pose the Object owns. This node owns the lens half and DELIBERATELY
// no position (the Object's `position` is the camera's position).
//
// ONE node with a `projection` discriminator, not two — the same call LightData made
// for four light kinds, and for the same reason: Blender models perspective and
// orthographic as ONE camera datablock with a Type enum, and the two fused nodes
// already share every param but `fov`/`zoom`. One union arm, one migration writer,
// one register entry, one inspector section.
//
// PARITY-FIRST: `lookAt` and `roll` STAY HERE (#387 D1). The design doc's longer-term
// target has the Object carry TRS with aim as a constraint; that migration is NOT
// exact for an ANIMATED camera, because rotation(t) is a non-linear function of three
// independently keyed channels whose key times need not coincide, so baking it would
// be an approximation where every prior kind's migration met a byte-identity gate.
// The shipped LightData made the same call for the same reason (`target`/`lookAt`
// stayed on the data half). The Object's `rotation` is consequently UNUSED by the
// camera road — see cameraRecompose.ts, which drops it.
//
// THE THING THAT MAKES THIS KIND DIFFERENT FROM EVERY EARLIER ONE: the camera does
// not render through its evaluated value. `CameraValue` reaches the renderer only as
// an ingredient in a render-cache key; what actually draws is a `CameraPose` that
// `activeCamera.ts` builds from RAW params. So `CameraDataValue` below is the
// recompose source for the VALUE road (Scene/CameraSelect/the passes), while the pose
// road reads these params directly. Both roads have to be taught the pair.
//
// Ranges are the SUPERSET across the two fused types so a migrated project's existing
// lens always re-parses.
//
// H14 hydrate seam: every DEFAULTED param re-guards with `?? default` in `evaluate`,
// so a migrated or hand-authored bag (which bypasses zod's default-fill) never yields
// an undefined lens field. `fov` is the ONE exception and it is deliberate — see the
// note on the schema field.
//
// Coexists with the fused Perspective/OrthographicCamera; nothing migrates in
// C4-Slice-1.
//
// REF: src/nodes/PerspectiveCamera.ts / OrthographicCamera.ts (the fused nodes and
//      their lens fields); src/nodes/cameraRecompose.ts (the flat-CameraValue
//      reconstruction); src/app/activeCamera.ts (the pose road); issue #387.

import { z } from 'zod';
import type { NodeDefinition } from '../core/dag/types';
import type { CameraDataValue } from './types';

export const CameraDataParams = z.object({
  /** Perspective vs orthographic — the single discriminator that collapses the two
   *  fused camera NODES into one datablock (Blender's Camera Type enum). */
  projection: z.enum(['Perspective', 'Orthographic']).default('Perspective'),
  /** Vertical field of view in DEGREES.
   *
   *  REQUIRED, with NO default, and that is a decision rather than an oversight: 45 is
   *  `DEFAULT_CAMERA_POSE.fov` — precisely what the pose road returns when a read
   *  FAILS. A `.default(45)` here would install that same value as a silent fallback
   *  one layer lower, in every hand-authored and migrated bag, so a camera whose fov
   *  never arrived would look exactly like a camera framed at 45°. Requiring it means
   *  the orthographic migration has to write an fov its source never had; that is one
   *  invented value in one place, which is the cheaper of the two costs.
   *
   *  Inert while `projection === 'Orthographic'` (the recompose reads `zoom` instead). */
  fov: z.number().min(1).max(170),
  /** Orthographic scale. Owned here regardless of how #478 resolves — it is a lens
   *  param by every definition including Blender's. (#478: nothing currently READS it.) */
  zoom: z.number().positive().default(50),
  near: z.number().positive().default(0.01),
  far: z.number().positive().default(500),
  /** Sensor height (mm) along the vertical FOV axis — authoring metadata for the
   *  focal-length inspector (UX #12). The renderer reads `fov`, not this. */
  sensorSize: z.number().positive().default(36),
  // Depth of field (UX #12). None of these reaches the render road under its own name
  // today — they are read RAW at the DoF resolver, so they cannot be animated (#193).
  // They live here anyway: they are lens params by meaning and Blender puts every one
  // of them on the camera DATA datablock (#387 D2).
  dofEnabled: z.boolean().default(false),
  focusDistance: z.number().positive().default(5),
  fStop: z.number().positive().default(2.8),
  /** #247 — when true the focus plane tracks the aim instead of `focusDistance`, so the
   *  effective distance becomes |position − lookAt|. Post-split that value SPANS both
   *  halves: `position` is the Object's, `lookAt` is this node's. */
  focusOnTarget: z.boolean().default(false),
  /** The aim point (authored framing orientation, not TRS — parity-first, #387 D1). */
  lookAt: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** Bank about the view axis in DEGREES (#229). Parity-first, as above. */
  roll: z.number().default(0),
});
export type CameraDataParams = z.infer<typeof CameraDataParams>;

export const CameraDataNode: NodeDefinition<CameraDataParams, CameraDataValue> = {
  type: 'CameraData',
  version: 1,
  pure: true,
  cost: 'cheap',
  paramSchema: CameraDataParams,
  inputs: {},
  outputs: { out: { type: 'ObjectData', cardinality: 'single' } },
  // The DEFINING section — a camera's substance is its lens. A data node owns no pose,
  // so no 'transform'/'constraint'/'driver' (those live on the Object).
  inspectorSections: ['camera'],
  evaluate(params) {
    return {
      kind: 'CameraData',
      // NORMALISED, not merely defaulted, and the difference is load-bearing. `?? ` only
      // catches `undefined`/`null`; a bag carrying some OTHER string passes straight
      // through, and nothing downstream re-checks. Load is where that arrives: it parses
      // the generic `NodeSchema` (`schema.ts`) and never a per-type `paramSchema`, so a
      // hand-edited or corrupted save reaches here unvalidated.
      //
      // The consequence is silent rather than loud. `CameraDataValue.projection` is typed
      // as the two-member union, so an out-of-union value makes this function violate its
      // own return type; `recomposeCameraObject`'s switch then matches no case and returns
      // `undefined`, which every one of its nine call sites absorbs with
      // `?? (inputs.camera as CameraValue)` — handing a raw `ObjectValue` to a camera
      // consumer, which reads `fov`/`near`/`far` as `undefined`.
      //
      // Fixing it HERE rather than with a `default:` arm in that switch is deliberate: the
      // switch's exhaustiveness over the union is what turns a future third projection into
      // a compile error, and a `default` would silently absorb it instead. Same shape as
      // `cameraProjectionFromPair` (`cameraNode.ts`), which already normalises this way —
      // one discriminator, one rule, both roads.
      projection: params.projection === 'Orthographic' ? 'Orthographic' : 'Perspective',
      // NO `?? fallback`, byte-identical to what the fused PerspectiveCamera does with
      // the same required param. Inventing one here would be the 45 the schema note
      // above refuses, just moved a layer further from where anyone would look for it.
      fov: params.fov,
      zoom: params.zoom ?? 50,
      near: params.near ?? 0.01,
      far: params.far ?? 500,
      sensorSize: params.sensorSize ?? 36,
      dofEnabled: params.dofEnabled ?? false,
      focusDistance: params.focusDistance ?? 5,
      fStop: params.fStop ?? 2.8,
      focusOnTarget: params.focusOnTarget ?? false,
      lookAt: params.lookAt ?? [0, 0, 0],
      roll: params.roll ?? 0,
    };
  },
};

// activeCamera — pure helpers that locate the scene's active camera node and
// read its pose. Used by the editor view camera (#165): when the viewport
// no longer renders THROUGH the DAG camera (it owns a free orbit camera
// instead), it still needs the active camera's pose to (a) boot the orbit
// view at that framing — byte-identical to the old makeDefault behavior —
// and (b) adopt it when "look through camera" is toggled on.
//
// Discipline: pure functions of DagState. No THREE, no React, no DAG
// mutation — unit-testable in isolation. The selector returns the camera
// NODE (a referentially-stable object across unrelated store updates, since
// Basher applies Ops immutably) so a zustand subscriber re-renders ONLY when
// the camera node itself changes (pose edit, re-wire), never on every store
// tick. Reading params directly mirrors framing.ts `anchorForNode` and
// Gizmo's `getManipulable` — both read `params.position` for cameras.
//
// `cameraPoseFromNode` reads the static AUTHORED pose (the base). For the
// EVALUATED pose at a given time — base overlaid with any keyframe channels
// targeting the camera — use `resolveActiveCameraPoseAt` (#190). The camera is
// wired via `scene.camera` (a single `Camera`-typed ref), NOT `scene.children`,
// so it sits outside the AnimationLayer/scene-child machinery; its channels
// target the camera node directly (no layer wrapper) and this file is where
// they are sampled and overlaid — the camera analogue of
// `resolveEvaluatedTransform` for scene children.
//
// REF: THESIS.md §11; vyapti V1, V8; issue #190.

import type { DagState } from '../core/dag';
import type { Node } from '../core/dag/types';
import { buildVec3Sampler, type KeyframeChannelVec3Params } from '../nodes/KeyframeChannelVec3';
import { sampleScalarKeyframes } from '../nodes/keyframeInterp';
import { resolveTrackToTarget } from './nodeConstraints';
import type { EvaluatorCache } from '../core/dag/evaluator';

export type CameraKind = 'PerspectiveCamera' | 'OrthographicCamera';

export interface CameraPose {
  kind: CameraKind;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  near: number;
  far: number;
}

/** Default editor framing — matches THESIS.md §11 and the default project's
 *  seed camera, so a camera-less scene still boots at a sane angle. */
export const DEFAULT_CAMERA_POSE: CameraPose = {
  kind: 'PerspectiveCamera',
  position: [3, 2, 3],
  lookAt: [0, 0, 0],
  fov: 45,
  near: 0.01,
  far: 1000,
};

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** Locate the node wired into `scene.camera`. Returns the Node object (stable
 *  identity) or null when no scene / no camera is wired. */
export function selectActiveCameraNode(state: DagState): Node | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const sceneNode = state.nodes[sceneRef.node];
  if (!sceneNode) return null;
  const camRef = sceneNode.inputs.camera;
  // scene.camera is a single NodeRef (not a list), per cameraFromView.ts.
  const ref = Array.isArray(camRef) ? camRef[0] : camRef;
  if (!ref || typeof ref !== 'object' || !('node' in ref)) return null;
  const id = (ref as { node?: string }).node;
  if (!id) return null;
  return state.nodes[id] ?? null;
}

/** Read a camera node's pose from its params, with defensive defaults so a
 *  malformed or pre-field-existed project never throws. Returns null only for
 *  a null node (caller falls back to DEFAULT_CAMERA_POSE). */
export function cameraPoseFromNode(node: Node | null): CameraPose | null {
  if (!node) return null;
  const p = node.params as Record<string, unknown>;
  const kind: CameraKind =
    node.type === 'OrthographicCamera' ? 'OrthographicCamera' : 'PerspectiveCamera';
  return {
    kind,
    position: isVec3(p.position) ? p.position : DEFAULT_CAMERA_POSE.position,
    lookAt: isVec3(p.lookAt) ? p.lookAt : DEFAULT_CAMERA_POSE.lookAt,
    fov: typeof p.fov === 'number' ? p.fov : DEFAULT_CAMERA_POSE.fov,
    near: typeof p.near === 'number' ? p.near : DEFAULT_CAMERA_POSE.near,
    far: typeof p.far === 'number' ? p.far : DEFAULT_CAMERA_POSE.far,
  };
}

/** Convenience: the active camera's static authored pose, or the default when
 *  none is wired. For the EVALUATED pose at a time, use
 *  `resolveActiveCameraPoseAt`. */
export function resolveActiveCameraPose(state: DagState): CameraPose {
  return cameraPoseFromNode(selectActiveCameraNode(state)) ?? DEFAULT_CAMERA_POSE;
}

/** The keyframe-able camera params. Cameras aim via `lookAt`, not the rotation
 *  band, so position + lookAt are the spatial channels; fov/near/far are scalar.
 *  This is the closed set the resolver overlays and the authoring path keys. */
export const ANIMATABLE_CAMERA_VEC3_PARAMS = ['position', 'lookAt'] as const;
export const ANIMATABLE_CAMERA_SCALAR_PARAMS = ['fov', 'near', 'far'] as const;

/**
 * The active camera's EVALUATED pose at clip-time `seconds` (#190): the static
 * authored base (`cameraPoseFromNode`) overlaid with any `KeyframeChannel*`
 * node whose `target` is the camera node, sampled at `seconds`.
 *
 * This is THE single source feeding the live viewport look-through (slice 4),
 * the still render (#168, slice 2), and the animation render (#189, slice 3),
 * so all three frame the SAME shot at time T (the V37/V51 viewport==render
 * parity invariant). One resolver, no parallel walk.
 *
 * PURE — a function of `(state, seconds)` only, with NO store reads. It samples
 * channels with the SAME shared interp primitives the channel nodes themselves
 * use (`buildVec3Sampler` / `sampleScalarKeyframes`), so it is the same sampling
 * math, not a parallel one (the H40 single-source rule). Held transient edits are
 * intentionally NOT overlaid here: a render is of committed DAG state, and
 * including uncommitted transients would break render parity — the live-edit
 * preview is a separate viewport concern.
 *
 * #204 Track-To migration: when the camera node carries an active Track-To
 * constraint, its `lookAt` is DERIVED from the target ([[V60]]) via the SAME
 * `resolveTrackToTarget` / `resolveWorldTransform` machinery meshes use — the
 * camera is no longer a bespoke aim, just a Track-To consumer that expresses the
 * aim as a lookAt POINT (Object3D.lookAt == the Matrix4.lookAt resolveTrackTo
 * runs). No camera constraint → the channel/static `lookAt` stands, byte-
 * identical to pre-#204. This is why it now (only on that branch) reaches the
 * world-transform resolver, which uses THREE matrix math + the evaluator.
 *
 * Unanimated cameras return the base pose unchanged (byte-identical to
 * `resolveActiveCameraPose`), so this is a safe drop-in for the static reads.
 */
export function resolveActiveCameraPoseAt(
  state: DagState,
  seconds: number,
  cache?: EvaluatorCache,
): CameraPose {
  const node = selectActiveCameraNode(state);
  const base = cameraPoseFromNode(node) ?? DEFAULT_CAMERA_POSE;
  if (!node) return base;

  // Overlay every channel targeting this camera node. Sample by the channel's
  // value type and write by paramPath. A channel with zero keyframes is skipped
  // (an empty sampler returns 0/[0,0,0] — never let that clobber the base).
  let pose: CameraPose | null = null; // clone lazily, only when a channel hits
  for (const ch of Object.values(state.nodes)) {
    if (!ch.type.startsWith('KeyframeChannel')) continue;
    const p = ch.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (p.target !== node.id) continue;
    const path = p.paramPath;
    const keyframes = Array.isArray(p.keyframes) ? p.keyframes : [];
    if (keyframes.length === 0) continue;

    if ((path === 'position' || path === 'lookAt') && ch.type === 'KeyframeChannelVec3') {
      pose ??= { ...base };
      const v = buildVec3Sampler(ch.params as KeyframeChannelVec3Params)(seconds);
      // sampleVec3Keyframes returns a readonly Vec3; copy into the mutable tuple.
      pose[path] = [v[0], v[1], v[2]];
    } else if (
      (path === 'fov' || path === 'near' || path === 'far') &&
      ch.type === 'KeyframeChannelNumber'
    ) {
      pose ??= { ...base };
      // Sort defensively before sampling (#200): `sampleScalarKeyframes` REQUIRES
      // a time-sorted list (it walks adjacent pairs, no internal sort), and
      // `KeyframeChannelNumber.evaluate` sorts the SAME way before its `.sample()`.
      // Without this, an out-of-order keyframe array would make this render path
      // interpolate against an unsorted list while the inspector read-side
      // (`resolveEvaluatedParam` → the channel's sorted `evaluate().sample`)
      // reads the sorted one → the two surfaces silently disagree. The vec3
      // branch already gets this for free via `buildVec3Sampler` (which sorts).
      const sorted = [...(keyframes as Parameters<typeof sampleScalarKeyframes>[0])].sort(
        (a, b) => a.time - b.time,
      );
      pose[path] = sampleScalarKeyframes(sorted, seconds);
    }
  }

  // #204 Track-To migration — an active Track-To on the camera node DERIVES its
  // aim ([[V60]]): lookAt = the target's world position (node-ref via #202, or the
  // fixed aimPoint), through the SAME resolver meshes use. It takes over the
  // lookAt (over the static param + any lookAt channel above). null → no camera
  // constraint → the channel/static lookAt stands (byte-identical to pre-#204).
  const aimTarget = resolveTrackToTarget(
    state,
    node.id,
    { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } },
    cache,
  );
  if (aimTarget) {
    pose ??= { ...base };
    pose.lookAt = aimTarget;
  }
  return pose ?? base;
}

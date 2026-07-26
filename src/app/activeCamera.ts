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
// `cameraPoseForNodeId` reads the static AUTHORED pose (the base) from BOTH
// halves of a split camera, or from the single node of a fused one. For the
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
import type { Node, NodeRef } from '../core/dag/types';
import { buildVec3Sampler, type KeyframeChannelVec3Params } from '../nodes/KeyframeChannelVec3';
import {
  sampleScalarKeyframes,
  sampleScalarKeyframesExtended,
  resolveExtend,
  type ChannelExtend,
  type ChannelExtrapolate,
} from '../nodes/keyframeInterp';
import type { FChannelModifier } from '../nodes/channelModifiers';
import { bareChannelNodesForSubject } from './nodeChannels';
import { linkedDataNodeId } from './resolveDataParamOwner';

/** #270/#274/#275 — RESOLVE a channel's stored extend model (per-side hold/slope
 *  extrapolation + an optional Cycles F-Modifier) into the engine's rule + counts +
 *  the F-Modifier stack, so the camera-pose scalar path honours them exactly like
 *  `ch.sample()` does (H40: render == read). Undefined fields fall through to the
 *  sampler's hold/0/[] defaults. */
function channelExtendArgs(
  params: unknown,
): [ChannelExtend, ChannelExtend, number, number, readonly FChannelModifier[] | undefined] {
  const p = params as {
    extendBefore?: ChannelExtrapolate;
    extendAfter?: ChannelExtrapolate;
    modifiers?: readonly FChannelModifier[];
  };
  const { before, after, cyclesBefore, cyclesAfter } = resolveExtend(
    p.extendBefore,
    p.extendAfter,
    p.modifiers,
  );
  return [before, after, cyclesBefore, cyclesAfter, p.modifiers];
}
import { resolveCameraSelectIndex } from '../nodes/CameraSelect';
import { resolveTrackToTarget, resolveConstraintPosition } from './nodeConstraints';
import { resolveParentWorldMatrix } from './resolveWorldTransform';
import { composeCameraPoseWithParent } from './cameraOrientation';
import type { EvaluatorCache } from '../core/dag/evaluator';

export type CameraKind = 'PerspectiveCamera' | 'OrthographicCamera';

export interface CameraPose {
  kind: CameraKind;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  near: number;
  far: number;
  /** Roll about the view axis, in DEGREES (#229). Banks the implicit up-vector
   *  the lookAt model otherwise leaves at world +Y. 0 = no roll. */
  roll: number;
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
  roll: 0,
};

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number');
}

/** Locate the node wired into `scene.camera`. Returns the Node object (stable
 *  identity) or null when no scene / no camera is wired.
 *
 *  #231 Inc 3 — when a `CameraSelect` feeds `scene.camera` (the multi-camera
 *  model), this resolves THROUGH it to the active camera node (by `active` index,
 *  V44 index-correspondence on `inputs.cameras`). A camera wired DIRECTLY (every
 *  pre-change project) is returned unchanged — the fallback, no migration. Pass
 *  `seconds` to honour a keyframed `active` (camera CUTS at that frame); omit it
 *  for the static "active now" used by the editor look-through + outliner marker. */
export function selectActiveCameraNode(state: DagState, seconds?: number): Node | null {
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
  const node = state.nodes[id] ?? null;
  if (node?.type === 'CameraSelect') return resolveActiveCameraFromSelect(state, node, seconds);
  return node;
}

/** Resolve a `CameraSelect` to its active camera NODE (id-side of the switch,
 *  mirroring `CameraSelect.evaluate`'s value-side). Recovers the camera id from
 *  `inputs.cameras[active].node` (edge order, V44) using the SHARED
 *  `resolveCameraSelectIndex` clamp so render == resolver (H40). */
function resolveActiveCameraFromSelect(
  state: DagState,
  selectNode: Node,
  seconds?: number,
): Node | null {
  const edges = Array.isArray(selectNode.inputs.cameras)
    ? (selectNode.inputs.cameras as NodeRef[])
    : [];
  const idx = resolveCameraSelectIndex(
    sampleCameraSelectActive(state, selectNode, seconds),
    edges.length,
  );
  if (idx === null) return null;
  const camId = edges[idx]?.node;
  if (!camId) return null;
  return state.nodes[camId] ?? null;
}

/** The CameraSelect's `active` index at `seconds` — static param, overlaid by a
 *  `KeyframeChannelNumber` targeting this node's `active` paramPath (the same
 *  free-floating-channel mechanism every other animatable param uses, V57). Omit
 *  `seconds` → the static authored index. */
function sampleCameraSelectActive(state: DagState, selectNode: Node, seconds?: number): number {
  const params = selectNode.params as { active?: unknown };
  const base = typeof params.active === 'number' ? params.active : 0;
  if (seconds === undefined) return base;
  for (const ch of Object.values(state.nodes)) {
    if (ch.type !== 'KeyframeChannelNumber') continue;
    const p = ch.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    if (p.target !== selectNode.id || p.paramPath !== 'active') continue;
    const keyframes = Array.isArray(p.keyframes) ? p.keyframes : [];
    if (keyframes.length === 0) continue;
    // Same defensive sort the camera-pose scalar branch uses (#200): the sampler
    // walks adjacent pairs with no internal sort.
    const sorted = [...(keyframes as Parameters<typeof sampleScalarKeyframes>[0])].sort(
      (a, b) => a.time - b.time,
    );
    return sampleScalarKeyframesExtended(sorted, seconds, ...channelExtendArgs(ch.params));
  }
  return base;
}

/** Every camera NODE id in the DAG, in stable enumeration order (Object.values
 *  insertion order). Blender draws every camera object, not just the active one:
 *  the viewport frustums (#165, SceneFromDAG), the outliner camera rows (#231 Inc
 *  3.2), and the `CameraSelect` lazy-insert (`buildSetActiveCameraOps`) all share
 *  this ONE list so they agree on the camera set + its order (the index a
 *  CameraSelect addresses by). */
export function enumerateCameraNodeIds(state: DagState): string[] {
  return Object.values(state.nodes)
    .filter((n) => n.type === 'PerspectiveCamera' || n.type === 'OrthographicCamera')
    .map((n) => n.id);
}

/** A camera's WORLD pose for the viewport FRUSTUM (#231 Inc 3.3): its static
 *  authored local pose lifted by the parent Group's world when nested. Returns
 *  null for a missing/non-camera node. `resolveParentWorldMatrix` returns null for
 *  a top-level camera → the local pose unchanged (byte-identical to pre-Inc-3.3).
 *  Static (not channel-evaluated) — the frustum mirrors the editor's static read;
 *  the ACTIVE camera's animated pose comes from `resolveActiveCameraPoseAt`. */
export function resolveCameraFrustumPose(
  state: DagState,
  cameraId: string,
  ctx: { time: { frame: number; seconds: number; normalized: number } },
  cache?: EvaluatorCache,
): CameraPose | null {
  const local = cameraPoseForNodeId(state, cameraId);
  if (!local) return null;
  const parentWorld = resolveParentWorldMatrix(state, cameraId, ctx, cache);
  return parentWorld ? composeCameraPoseWithParent(local, parentWorld) : local;
}

/** The `CameraData` node an Object poses, or null when there is none — a fused
 *  camera, or an Object posing some other kind of data.
 *
 *  The type check is not defensive padding: `linkedDataNodeId` returns whatever
 *  hangs off the `data` input, and reading lens params off a `BoxData` would
 *  silently produce `DEFAULT_CAMERA_POSE`'s fov rather than an error (#387 V-45,
 *  the value a failed read hands back). */
export function cameraDataNodeFor(state: DagState, cameraId: string): Node | null {
  const dataId = linkedDataNodeId(state, cameraId);
  if (!dataId) return null;
  const data = state.nodes[dataId] ?? null;
  return data?.type === 'CameraData' ? data : null;
}

/**
 * Read a camera's pose from the params of its two halves, with defensive defaults
 * so a malformed or pre-field-existed project never throws. Returns null only for
 * a null object node (caller falls back to DEFAULT_CAMERA_POSE).
 *
 * #387 — the pose is now SPANNED across the pair. `position` is the Object's;
 * `lookAt`/`roll`/`fov`/`near`/`far` are the `CameraData`'s (parity-first, D1: the
 * aim stays on the data half, so a keyed camera never needs a non-commuting
 * aim→rotation bake). `dataNode === null` is the FUSED case and reads every field
 * off the object node, byte-identical to the pre-split single-node read.
 *
 * This is the one place the two halves are recombined for the pose road. The value
 * road recombines them separately in `recomposeCameraObject`, because the renderer
 * never reads a camera's evaluated value — see that file.
 */
export function cameraPoseFromPair(
  objectNode: Node | null,
  dataNode: Node | null,
): CameraPose | null {
  if (!objectNode) return null;
  const o = objectNode.params as Record<string, unknown>;
  // Fused: one node holds everything. Split: the lens half answers for everything
  // but `position`, which the Object owns.
  const lens = (dataNode ? dataNode.params : o) as Record<string, unknown>;
  const kind: CameraKind = dataNode
    ? lens.projection === 'Orthographic'
      ? 'OrthographicCamera'
      : 'PerspectiveCamera'
    : objectNode.type === 'OrthographicCamera'
      ? 'OrthographicCamera'
      : 'PerspectiveCamera';
  return {
    kind,
    position: isVec3(o.position) ? o.position : DEFAULT_CAMERA_POSE.position,
    lookAt: isVec3(lens.lookAt) ? lens.lookAt : DEFAULT_CAMERA_POSE.lookAt,
    fov: typeof lens.fov === 'number' ? lens.fov : DEFAULT_CAMERA_POSE.fov,
    near: typeof lens.near === 'number' ? lens.near : DEFAULT_CAMERA_POSE.near,
    far: typeof lens.far === 'number' ? lens.far : DEFAULT_CAMERA_POSE.far,
    roll: typeof lens.roll === 'number' ? lens.roll : DEFAULT_CAMERA_POSE.roll,
  };
}

/** {@link cameraPoseFromPair} applied to a node id — resolves the data half itself.
 *  Prefer this at every call site that has the state: it cannot be given only one
 *  half of a split camera by accident. */
export function cameraPoseForNodeId(state: DagState, cameraId: string): CameraPose | null {
  const node = state.nodes[cameraId] ?? null;
  if (!node) return null;
  return cameraPoseFromPair(node, cameraDataNodeFor(state, cameraId));
}

/** Convenience: the active camera's static authored pose, or the default when
 *  none is wired. For the EVALUATED pose at a time, use
 *  `resolveActiveCameraPoseAt`. */
export function resolveActiveCameraPose(state: DagState): CameraPose {
  const node = selectActiveCameraNode(state);
  return (node ? cameraPoseForNodeId(state, node.id) : null) ?? DEFAULT_CAMERA_POSE;
}

/**
 * The active camera's EVALUATED pose at clip-time `seconds` (#190): the static
 * authored base (`cameraPoseForNodeId`) overlaid with any `KeyframeChannel*`
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
  // #231 Inc 3 — resolve the active camera AT `seconds`, so a keyframed
  // `CameraSelect.active` CUTS the rendered/look-through shot to the camera live
  // at that frame. A direct-wired camera (or static `active`) resolves to the
  // same node every frame (byte-identical to pre-Inc-3).
  const node = selectActiveCameraNode(state, seconds);
  if (!node) return DEFAULT_CAMERA_POSE;
  return resolveCameraPoseAt(state, node.id, seconds, cache);
}

/** [[V85]]/[[H132]] — the EVALUATED pose of ANY camera node at clip-time `seconds`
 *  (not only the active one): static base + keyframe channels + Track-To aim +
 *  parent-group world. `resolveActiveCameraPoseAt` is this applied to the active
 *  node; the camera-frustum FOLLOWER (SceneFromDAG) applies it per camera so every
 *  frustum tracks its OWN animation — the box-parity the static, channel-blind
 *  `resolveCameraFrustumPose` lacked. PURE — a function of (state, cameraId,
 *  seconds), no store reads. */
export function resolveCameraPoseAt(
  state: DagState,
  cameraId: string,
  seconds: number,
  cache?: EvaluatorCache,
): CameraPose {
  const node = state.nodes[cameraId] ?? null;
  const base = cameraPoseForNodeId(state, cameraId) ?? DEFAULT_CAMERA_POSE;
  if (!node) return base;

  // Overlay every channel belonging to this camera. Sample by the channel's value
  // type and write by paramPath.
  //
  // #387 — "belonging to" spans the PAIR, and this is the hazard the camera split
  // turns on. The scan used to match `params.target === node.id` by hand; post-split
  // the lens lives on the CameraData, so `addChannel` routes an fov/clip/aim channel
  // to the DATA id while the user selects, and every surface addresses, the Object.
  // An exact-id scan therefore finds nothing and the camera freezes on screen while
  // the inspector still shows the value moving — silently, because "no channels" is a
  // legitimate answer. `bareChannelNodesForSubject` is the SAME enumerator the
  // management surfaces use (V108: one predicate, no second walk), it preserves
  // Object-first order, and it already drops empty channels — so the inline
  // zero-keyframe skip that used to live here is gone rather than duplicated.
  let pose: CameraPose | null = null; // clone lazily, only when a channel hits
  for (const ch of bareChannelNodesForSubject(
    state.nodes,
    node.id,
    linkedDataNodeId(state, node.id),
  )) {
    const p = ch.params as { target?: unknown; paramPath?: unknown; keyframes?: unknown };
    const path = p.paramPath;
    const keyframes = Array.isArray(p.keyframes) ? p.keyframes : [];

    if ((path === 'position' || path === 'lookAt') && ch.type === 'KeyframeChannelVec3') {
      pose ??= { ...base };
      const v = buildVec3Sampler(ch.params as KeyframeChannelVec3Params)(seconds);
      // sampleVec3Keyframes returns a readonly Vec3; copy into the mutable tuple.
      pose[path] = [v[0], v[1], v[2]];
    } else if (
      (path === 'fov' || path === 'near' || path === 'far' || path === 'roll') &&
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
      pose[path] = sampleScalarKeyframesExtended(sorted, seconds, ...channelExtendArgs(ch.params));
    }
  }

  // #204 Track-To migration — an active Track-To on the camera node DERIVES its
  // aim ([[V60]]): lookAt = the target's world position (node-ref via #202, or the
  // fixed aimPoint), through the SAME resolver meshes use. It takes over the
  // lookAt (over the static param + any lookAt channel above). null → no camera
  // constraint → the channel/static lookAt stands (byte-identical to pre-#204).
  const ctx = { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };

  // #339 Follow-Path — a camera is posed by THIS resolver, not by the mesh road
  // (ConstrainedR / resolveEvaluatedTransform), so the POSITION band has to be folded here
  // too or the headline case is the one that silently doesn't work: a Follow-Path on a
  // camera would place nothing while a Follow-Path on a cube worked perfectly, because a
  // camera never goes near the scene-child walk. Same fold, same seam, same order as the
  // aim below — one band, every caller.
  //
  // The two bands need no ordering HERE, and for a nicer reason than on the mesh road: a
  // camera aims by a lookAt POINT, not a rotation, so the orientation is derived from
  // (position → lookAt) downstream by `cameraOrientationQuat`. Move the camera and the aim
  // follows for free. `resolveConstraintPosition` returns PARENT-LOCAL, which is exactly
  // what the parent compose below expects.
  const followed = resolveConstraintPosition(state, node.id, ctx, cache);
  if (followed) {
    pose ??= { ...base };
    pose.position = followed;
  }

  const aimTarget = resolveTrackToTarget(state, node.id, ctx, cache);
  if (aimTarget) {
    pose ??= { ...base };
    pose.lookAt = aimTarget;
  }

  // #231 Inc 3.3 — a camera nested in a Group frames from the group-composed WORLD.
  // Compose AFTER the channel + Track-To overlays so the animated/aimed LOCAL pose
  // is what gets lifted into world. `resolveParentWorldMatrix` returns null for a
  // top-level camera (wired only to scene.camera) → byte-identical to the flat pose,
  // so this is a safe drop-in for every pre-Inc-3.3 project.
  const parentWorld = resolveParentWorldMatrix(state, node.id, ctx, cache);
  const result = pose ?? base;
  return parentWorld ? composeCameraPoseWithParent(result, parentWorld) : result;
}

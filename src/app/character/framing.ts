// Camera framing — Frame Selected / Frame All for the editor's
// OrbitControls camera. v0.5 uses the manual path: compute a target point,
// set OrbitControls.target, then translate the camera so the offset
// (direction × distance) from the previous target is preserved. drei's
// OrbitControls doesn't ship `.fit()`, and swapping to <CameraControls />
// would change the mouse map for existing tests. Manual is enough.
//
// File-rooted V8: this module lives in src/app/, reads the editor camera
// from useThreeRef (a UI projection store), and never touches the DAG.
//
// REF: THESIS.md §11.

import * as THREE from 'three';
import { evaluate } from '../../core/dag/evaluator';
import { fitViewToSphere, orthoZoomForView } from '../../viewport/cameraFit';
import { computeSceneBounds, type SceneBounds } from '../../viewport/sceneBounds';
import { boneFramesBounds, skeletonObjectFrames } from '../../viewport/skeletonObjectPose';
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import type { CharacterValue } from '../../nodes/types';
import { collectSkeletonObjects } from '../skeletonObjects';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import { useThreeRef } from './threeRef';

/** Default camera offset used when nothing is on screen yet. Matches the
 *  initial editor pose (THESIS.md §11). */
const DEFAULT_OFFSET = new THREE.Vector3(3, 2, 3);

/** Vertical FOV assumed when the editor camera cannot supply one (an ortho view,
 *  which has no FOV of its own — the boot fit passes the seed camera's the same
 *  way). Matches `DEFAULT_FOV` in the viewport's own fit. */
const DEFAULT_FOV_DEG = 50;

/** Read the world-space "anchor" position for a DAG node. Best-effort:
 *   - anything carrying `params.position` (Transform / Camera / Light / Group,
 *     including the Group an import mints — it bakes position = the model centre).
 *   - Character: evaluate at current scrub time and read CharacterValue.position.
 *   - Otherwise: null (no anchor available).
 *
 *  EXPORTED FOR TESTING (#856). Which nodes can be framed was previously
 *  unstated and untested, and the two ways of finding out were reading this
 *  function or noticing that the camera did not move. A director's report that
 *  "Frame Selected does nothing" is a claim about THIS set, so the set needs to
 *  be assertable without a camera. */
export function anchorForNode(nodeId: NodeId): THREE.Vector3 | null {
  const dag = useDagStore.getState().state;
  const node = dag.nodes[nodeId];
  if (!node) return null;
  const params = node.params as Record<string, unknown>;
  const pos = params.position;
  if (Array.isArray(pos) && pos.length === 3 && pos.every((n) => typeof n === 'number')) {
    return new THREE.Vector3(pos[0], pos[1], pos[2]);
  }
  if (node.type === 'Character') {
    try {
      const t = useTimeStore.getState();
      const result = evaluate(dag, nodeId, {
        ctx: { time: { frame: t.frame, seconds: t.seconds, normalized: t.normalized } },
      });
      const v = result.value as CharacterValue;
      return new THREE.Vector3(v.position[0], v.position[1], v.position[2]);
    } catch {
      return null;
    }
  }
  return null;
}

/** World-space bounding sphere of what a node actually DRAWS, or null when it
 *  draws nothing measurable (a light, a camera, an empty group, or a node whose
 *  object has not mounted yet). A skeleton Object's bones count, though they are
 *  drawn as chrome outside its group (#1179).
 *
 *  Read off the live scene by object name — `SceneFromDAG` names each object
 *  for its node id, which is the same lookup `__basher_mesh_world_bounds` uses —
 *  and measured with the SAME walk "frame all" uses at boot, so editor chrome is
 *  pruned rather than framed (#546).
 *
 *  EXPORTED FOR TESTING, for the reason `anchorForNode` is: "Frame Selected did
 *  not fit my character" is a claim about which nodes have measurable bounds,
 *  and that has to be assertable without a camera. */
export function boundsForNode(nodeId: NodeId): SceneBounds | null {
  const scene = useThreeRef.getState().scene;
  const object = scene?.getObjectByName(nodeId);
  return unionBounds(object ? computeSceneBounds(object) : null, skeletonObjectBounds(nodeId));
}

/** #1179 — the drawn bones of a skeleton Object, or null when the node is not one.
 *
 *  Its bones are editor chrome, drawn by the armature helper OUTSIDE the Object's group, so
 *  the scene walk above finds an empty group and the fit had nothing to fit: `F` fell through
 *  to the anchor, the Object's own origin, which is where the camera already pointed. The
 *  bones are measured with the helper's own function at the playhead, so what is fitted is
 *  what is drawn — posed, heads and tails, in world space, as the reference fits an armature. */
function skeletonObjectBounds(nodeId: NodeId): SceneBounds | null {
  const state = useDagStore.getState().state;
  if (state.nodes[nodeId]?.type !== 'Object') return null;
  const rig = collectSkeletonObjects(state).find((o) => o.id === nodeId);
  if (!rig) return null;
  return boneFramesBounds(skeletonObjectFrames(rig, useTimeStore.getState().seconds));
}

/** The sphere enclosing both, or whichever one exists. */
function unionBounds(a: SceneBounds | null, b: SceneBounds | null): SceneBounds | null {
  if (!a || !b) return a ?? b;
  const sphere = new THREE.Sphere(new THREE.Vector3(...a.center), a.radius).union(
    new THREE.Sphere(new THREE.Vector3(...b.center), b.radius),
  );
  return { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius };
}

/** Frame a bounding sphere: re-centre on it AND set the distance so it fills
 *  the view, keeping the current viewing ANGLE.
 *
 *  🔑 WHY THIS IS SEPARATE FROM `applyTarget` (#969). `applyTarget` preserves
 *  the camera's existing offset by design — it is the whole of the camera math
 *  a FOLLOW needs, and a follow that re-derived its distance every frame would
 *  dolly at the subject while it walked. So fitting is added BESIDE it rather
 *  than inside it: framing is a gesture, following is a constraint, and only the
 *  gesture is allowed to change how far away the camera is.
 *
 *  The angle is preserved because that is what the reference does. Measured in
 *  Blender 4.5.9, parking the view at distance 50 and taking View Selected on
 *  the default 2 m cube: `view_location` goes to (0,0,0) and `view_distance` to
 *  3.279, with the view rotation untouched. A director's orbit is theirs; only
 *  the pivot and the distance are the gesture's to set. */
export function applyFit(bounds: SceneBounds): boolean {
  const cam = useThreeRef.getState().camera;
  const ctrlTarget = useThreeRef.getState().controlsTarget;
  if (!cam) return false;

  const center = new THREE.Vector3(bounds.center[0], bounds.center[1], bounds.center[2]);

  // The direction the director is already looking from. A camera sitting ON its
  // target has no direction to preserve, so fall back to the canonical angle
  // rather than normalising a zero vector into NaN.
  const offset = ctrlTarget
    ? new THREE.Vector3().subVectors(cam.position, ctrlTarget)
    : DEFAULT_OFFSET.clone();
  const dir = offset.lengthSq() > 1e-12 ? offset.normalize() : DEFAULT_OFFSET.clone().normalize();

  const persp = cam as THREE.PerspectiveCamera;
  const isPersp = persp.isPerspectiveCamera === true;
  const fovDeg = isPersp && persp.fov > 0 ? persp.fov : DEFAULT_FOV_DEG;
  const aspect = isPersp && persp.aspect > 0 ? persp.aspect : 1;

  const fit = fitViewToSphere(bounds.center, bounds.radius, fovDeg, aspect, {
    dir: [dir.x, dir.y, dir.z],
  });

  cam.position.set(fit.position[0], fit.position[1], fit.position[2]);
  if (ctrlTarget) ctrlTarget.copy(center);
  cam.lookAt(center);

  // #1179 — move the dolly range WITH the camera. OrbitControls clamps the distance into
  // [minDistance, maxDistance] on its next update, and that range was last set by the boot
  // fit for whatever the scene held then: fitting a 161-unit rig after booting on a 1 m cube
  // was measured landing at 38.08 = (2.94 + 0.866) × 10, the cube's limit, not the rig's fit.
  // Same rule the boot fit applies: the range is the fit's, and never excludes where the
  // camera now stands.
  const limits = useThreeRef.getState().dollyLimits;
  if (limits) {
    limits.minDistance = Math.min(fit.minDistance, fit.distance);
    limits.maxDistance = Math.max(fit.maxDistance, fit.distance);
  }

  // An ORTHOGRAPHIC editor view is not framed by position at all — its frustum
  // extent is `zoom` (`orthoZoomForView`, the same math the boot fit uses), so
  // moving it alone would re-centre and leave the subject the same size.
  const ortho = cam as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    const height = useThreeRef.getState().gl?.domElement.clientHeight ?? 0;
    if (height > 0) {
      ortho.zoom = orthoZoomForView(cam.position.distanceTo(center), fovDeg, height);
      ortho.updateProjectionMatrix();
    }
  }

  cam.updateMatrixWorld();
  return true;
}

/** Apply a new target to OrbitControls + translate the camera so the
 *  camera-to-target offset is preserved.
 *
 *  Returns whether it actually moved a camera. There is no camera before the
 *  viewport mounts, and "no camera" is indistinguishable at the call site from
 *  "framed successfully" unless it is reported.
 *
 *  🔑 EXPORTED because this is also the whole of the camera math a FOLLOW needs
 *  (#856), and the two must not be two implementations. Re-centring on a point
 *  is a fixed point of OrbitControls' own update — it recomputes
 *  `offset = position - target` and writes back `position = target + offset`
 *  (three-stdlib/controls/OrbitControls.js, `update`) — so translating both ends
 *  together survives the next frame, while moving the camera alone does not
 *  (its orientation is rewritten by `lookAt(target)` against the OLD target).
 *  Calling this every frame with a moving point IS the follow; the only thing
 *  the follow adds is which point (src/viewport/cameraFollow.ts). */
export function applyTarget(target: THREE.Vector3): boolean {
  const cam = useThreeRef.getState().camera;
  const ctrlTarget = useThreeRef.getState().controlsTarget;
  if (!cam) return false;
  if (ctrlTarget) {
    const offset = new THREE.Vector3().subVectors(cam.position, ctrlTarget);
    cam.position.copy(target).add(offset);
    ctrlTarget.copy(target);
  } else {
    cam.position.copy(target).add(DEFAULT_OFFSET);
  }
  cam.lookAt(target);
  cam.updateMatrixWorld();
  return true;
}

/**
 * Frame the primary selection. Returns whether it framed anything.
 *
 * #856 — IT HAS ALWAYS HAD TWO WAYS OF DOING NOTHING, and only one of them was
 * visible to callers. Nothing selected is the obvious one. The other is a node
 * with no anchor, which is silent and is the one a director actually hits: the
 * report is "Frame Selected does nothing on my character", and the affordance
 * that exists to make the button always useful (`homeFrame`) was guarding on
 * `primaryNodeId !== null` — a PROXY for "this will work" rather than the thing
 * itself. So it called through and the fallback never fired.
 *
 * Reporting rather than falling back here on purpose: this function's contract
 * is "frame the selection", and whether a failure should become Frame All is a
 * question about the affordance, which is where the answer now lives.
 */
export function frameSelected(): boolean {
  const primary = useSelectionStore.getState().primaryNodeId;
  if (!primary) return false;
  // FIT first: what the node draws decides how far away to stand. An imported
  // character is the case this exists for — its Group anchors at the model
  // centre, which is where the camera is already pointing, so re-centring on it
  // moved the camera a few centimetres and left the character inside the cube.
  const bounds = boundsForNode(primary);
  if (bounds) return applyFit(bounds);
  // Nothing drawn (a light, a camera, a Character with no mounted object): the
  // anchor road still re-centres, which is all there is to do without a size.
  const anchor = anchorForNode(primary);
  if (!anchor) return false;
  return applyTarget(anchor);
}

/** Frame all top-level scene children — average their anchors. Falls back
 *  to the world origin when no top-level node has an anchor. */
export function frameAll(): void {
  const dag = useDagStore.getState().state;
  const sceneRef = dag.outputs.scene;
  const sceneNode = sceneRef ? dag.nodes[sceneRef.node] : null;
  const children =
    sceneNode && Array.isArray(sceneNode.inputs.children)
      ? (sceneNode.inputs.children as { node: string }[])
      : [];
  const sum = new THREE.Vector3();
  let count = 0;
  for (const ref of children) {
    const a = anchorForNode(ref.node);
    if (a) {
      sum.add(a);
      count++;
    }
  }
  // Same gesture, whole scene: fit what the scene DRAWS, which is the bound the
  // boot fit already frames against (#186). The anchor average below is the
  // fallback for a scene that draws nothing measurable.
  const scene = useThreeRef.getState().scene;
  const bounds = scene ? computeSceneBounds(scene) : null;
  if (bounds && applyFit(bounds)) return;

  const target = count > 0 ? sum.divideScalar(count) : new THREE.Vector3(0, 0, 0);
  applyTarget(target);
}

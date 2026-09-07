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
import { useDagStore } from '../../core/dag/store';
import type { NodeId } from '../../core/dag/types';
import type { CharacterValue } from '../../nodes/types';
import { useSelectionStore } from '../stores/selectionStore';
import { useTimeStore } from '../stores/timeStore';
import { useThreeRef } from './threeRef';

/** Default camera offset used when nothing is on screen yet. Matches the
 *  initial editor pose (THESIS.md §11). */
const DEFAULT_OFFSET = new THREE.Vector3(3, 2, 3);

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

/** Apply a new target to OrbitControls + translate the camera so the
 *  camera-to-target offset is preserved.
 *
 *  Returns whether it actually moved a camera. There is no camera before the
 *  viewport mounts, and "no camera" is indistinguishable at the call site from
 *  "framed successfully" unless it is reported. */
function applyTarget(target: THREE.Vector3): boolean {
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
  const target = count > 0 ? sum.divideScalar(count) : new THREE.Vector3(0, 0, 0);
  applyTarget(target);
}

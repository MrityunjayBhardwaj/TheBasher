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
 *   - Transform / Camera / Light: read params.position when present.
 *   - Character: evaluate at current scrub time and read CharacterValue.position.
 *   - Otherwise: null (no anchor available).
 */
function anchorForNode(nodeId: NodeId): THREE.Vector3 | null {
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
 *  camera-to-target offset is preserved. */
function applyTarget(target: THREE.Vector3): void {
  const cam = useThreeRef.getState().camera;
  const ctrlTarget = useThreeRef.getState().controlsTarget;
  if (!cam) return;
  if (ctrlTarget) {
    const offset = new THREE.Vector3().subVectors(cam.position, ctrlTarget);
    cam.position.copy(target).add(offset);
    ctrlTarget.copy(target);
  } else {
    cam.position.copy(target).add(DEFAULT_OFFSET);
  }
  cam.lookAt(target);
  cam.updateMatrixWorld();
}

/** Frame the primary selection. No-op when nothing is selected or the node
 *  has no anchor. */
export function frameSelected(): void {
  const primary = useSelectionStore.getState().primaryNodeId;
  if (!primary) return;
  const anchor = anchorForNode(primary);
  if (!anchor) return;
  applyTarget(anchor);
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

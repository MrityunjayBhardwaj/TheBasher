// setActiveCamera — the ONE op-builder that makes a camera the scene's active
// camera (#231 Inc 3.2, the multi-camera "active" model UI). Blender's
// Ctrl-Numpad0 ("Set Active Object as Camera"): the keyboard shortcut, the
// outliner row action, and any future surface all dispatch the SAME ops (the
// "one write authority, N callers" shape, cf. sceneNodeActions.ts).
//
// LAZY auto-insert (the user-approved lifecycle): a single camera stays wired
// DIRECTLY to Scene.camera (byte-identical to every pre-Inc-3 project). The
// `CameraSelect` switch node materializes only when the scene holds 2+ cameras
// and you make a NON-active one active — at that point all cameras are gathered
// into one CameraSelect (in `enumerateCameraNodeIds` order, the index it
// addresses by, V44) and it is rewired into Scene.camera. Once a CameraSelect
// exists, "set active" is just a `setParam active` (+ a connect if the camera
// isn't yet in the selector).
//
// Pure: a function of (state, cameraNodeId) → Op[] | null. null = no-op (the
// camera is already active) or invalid (no scene / not a camera). The caller
// dispatchAtomic's the ops + manages selection.
//
// REF: src/app/activeCamera.ts (selectActiveCameraNode / enumerateCameraNodeIds);
//      src/nodes/CameraSelect.ts; src/app/character/cameraFromView.ts (the
//      disconnect→addNode→connect rewire template); vyapti V79/V44/V63.

import type { DagState } from '../core/dag/state';
import type { NodeRef, Op } from '../core/dag/types';
import { enumerateCameraNodeIds, selectActiveCameraNode } from './activeCamera';

function isCameraNode(state: DagState, id: string): boolean {
  const t = state.nodes[id]?.type;
  return t === 'PerspectiveCamera' || t === 'OrthographicCamera';
}

/** A node id derived from `base`, guaranteed absent from `nodes`. Deterministic
 *  (no Date.now/Math.random) so the builder is unit-testable. */
function uniqueId(base: string, nodes: DagState['nodes']): string {
  if (!nodes[base]) return base;
  let n = 2;
  while (nodes[`${base}_${n}`]) n += 1;
  return `${base}_${n}`;
}

/**
 * Ops to make `cameraNodeId` the scene's active camera, or null when that is a
 * no-op (already active) / impossible (no scene, not a camera).
 *
 * Three shapes:
 *  - **CameraSelect already feeds Scene.camera** → connect the camera into the
 *    selector if it isn't already, then `setParam active` to its index.
 *  - **≤1 camera in the scene** → wire it DIRECTLY into Scene.camera (no selector
 *    — the lazy model keeps single-camera scenes selector-free).
 *  - **2+ cameras, currently direct/none** → lazily insert a CameraSelect wiring
 *    ALL cameras (enumeration order), active = the chosen camera's index, and
 *    rewire it into Scene.camera.
 */
export function buildSetActiveCameraOps(state: DagState, cameraNodeId: string): Op[] | null {
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return null;
  const sceneNode = state.nodes[sceneRef.node];
  if (!sceneNode) return null;
  if (!isCameraNode(state, cameraNodeId)) return null;

  // Already the active camera → nothing to do (avoids a churning no-op undo).
  if (selectActiveCameraNode(state)?.id === cameraNodeId) return null;

  const camBinding = sceneNode.inputs.camera;
  const wired: NodeRef | null = Array.isArray(camBinding)
    ? (camBinding[0] ?? null)
    : (camBinding ?? null);
  const wiredNode = wired?.node ? state.nodes[wired.node] : null;

  // — Case A: a CameraSelect already drives Scene.camera. Just point it here.
  if (wiredNode?.type === 'CameraSelect') {
    const selId = wiredNode.id;
    const edges = Array.isArray(wiredNode.inputs.cameras)
      ? (wiredNode.inputs.cameras as NodeRef[])
      : [];
    let idx = edges.findIndex((e) => e.node === cameraNodeId);
    const ops: Op[] = [];
    if (idx < 0) {
      // The camera isn't in the selector yet (e.g. freshly added) → append it.
      ops.push({
        type: 'connect',
        from: { node: cameraNodeId, socket: 'out' },
        to: { node: selId, socket: 'cameras' },
      });
      idx = edges.length; // connect with no index appends at the end (ops.ts)
    }
    ops.push({ type: 'setParam', nodeId: selId, paramPath: 'active', value: idx });
    return ops;
  }

  // — Case B: direct-wired or no camera. Decide by how many cameras exist.
  const cams = enumerateCameraNodeIds(state);
  const ops: Op[] = [];
  if (wired) {
    ops.push({ type: 'disconnect', from: wired, to: { node: sceneRef.node, socket: 'camera' } });
  }

  if (cams.length <= 1) {
    // One camera in the whole scene → wire it directly (no selector needed).
    ops.push({
      type: 'connect',
      from: { node: cameraNodeId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'camera' },
    });
    return ops;
  }

  // 2+ cameras → lazily insert the CameraSelect, gathering ALL cameras in
  // enumeration order (the index it addresses by), active = the chosen one.
  const selId = uniqueId('n_camera_select', state.nodes);
  const activeIdx = cams.indexOf(cameraNodeId);
  ops.push({
    type: 'addNode',
    nodeId: selId,
    nodeType: 'CameraSelect',
    params: { active: activeIdx < 0 ? 0 : activeIdx },
  });
  for (const cid of cams) {
    ops.push({
      type: 'connect',
      from: { node: cid, socket: 'out' },
      to: { node: selId, socket: 'cameras' },
    });
  }
  ops.push({
    type: 'connect',
    from: { node: selId, socket: 'out' },
    to: { node: sceneRef.node, socket: 'camera' },
  });
  return ops;
}

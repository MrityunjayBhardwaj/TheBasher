// camera-from-view — snapshot the editor's OrbitControls camera pose into
// a new PerspectiveCamera DAG node and re-route `outputs.scene.camera` to
// it. The killer feature for the director-first thesis (THESIS.md §11):
// frame a shot via OrbitControls, then bake it into the DAG so renders
// reproduce that pose deterministically.
//
// Op chain (atomic):
//   1. addNode(PerspectiveCamera, { fov, position, lookAt })
//   2. setOutputs is implicit when we connect to scene.camera — but
//      setting an OUTPUT requires re-mapping `state.outputs.scene.camera`
//      directly (outputs are not Ops in v0.5; they're declared at boot).
//      For P2.1 we instead disconnect+reconnect the Scene aggregator's
//      `camera` input to the new node — mirrors the asset-drop pattern.
//
// REF: THESIS.md §11, vyapti V1, krama K7 (sister chain).

import { useThreeRef } from './threeRef';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';

export async function snapshotCameraFromOrbit(): Promise<void> {
  const cam = useThreeRef.getState().camera;
  if (!cam) return;
  const dag = useDagStore.getState();
  const state = dag.state;
  const sceneRef = state.outputs.scene;
  if (!sceneRef) return;
  const sceneNode = state.nodes[sceneRef.node];
  if (!sceneNode) return;
  const existing = sceneNode.inputs.camera;
  if (Array.isArray(existing)) return;

  // Read current orbit camera pose. drei's OrbitControls writes through
  // to the active perspective camera (THREE.PerspectiveCamera), so
  // cam.position + the controls' target give us a faithful snapshot.
  const target = useThreeRef.getState().controlsTarget;
  const newId = `cam_${Date.now().toString(36)}`;
  const camAny = cam as unknown as { isPerspectiveCamera?: boolean; fov?: number };
  const fov = camAny.isPerspectiveCamera && typeof camAny.fov === 'number' ? camAny.fov : 45;

  const ops: Op[] = [];
  if (existing) {
    ops.push({
      type: 'disconnect',
      from: existing,
      to: { node: sceneRef.node, socket: 'camera' },
    });
  }
  ops.push({
    type: 'addNode',
    nodeId: newId,
    nodeType: 'PerspectiveCamera',
    params: {
      fov,
      near: 0.1,
      far: 1000,
      position: [cam.position.x, cam.position.y, cam.position.z],
      lookAt: target ? [target.x, target.y, target.z] : [0, 0, 0],
    },
  });
  ops.push({
    type: 'connect',
    from: { node: newId, socket: 'out' },
    to: { node: sceneRef.node, socket: 'camera' },
  });

  dag.dispatchAtomic(ops, 'user', 'camera-from-view');
}

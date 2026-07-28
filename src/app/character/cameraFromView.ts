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
  // #387 C4 — camera-from-view mints the object↔data split: a CameraData (the lens the
  // editor view is wearing) and an Object (the pose it is sitting at), wired via `data`.
  // The lens/pose values are byte-identical to what the fused node carried; only the shape
  // changed. `scene.camera` is wired to the OBJECT — it is the posable half, it inherits the
  // role the fused node had, and it is what every camera consumer addresses.
  const dataId = `${newId}__data`;
  ops.push({
    type: 'addNode',
    nodeId: dataId,
    nodeType: 'CameraData',
    params: {
      projection: 'Perspective',
      fov,
      near: 0.01,
      far: 1000,
      lookAt: target ? [target.x, target.y, target.z] : [0, 0, 0],
    },
  });
  ops.push({
    type: 'addNode',
    nodeId: newId,
    nodeType: 'Object',
    params: {
      position: [cam.position.x, cam.position.y, cam.position.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  ops.push({
    type: 'connect',
    from: { node: dataId, socket: 'out' },
    to: { node: newId, socket: 'data' },
  });
  ops.push({
    type: 'connect',
    from: { node: newId, socket: 'out' },
    to: { node: sceneRef.node, socket: 'camera' },
  });

  dag.dispatchAtomic(ops, 'user', 'camera-from-view');
}

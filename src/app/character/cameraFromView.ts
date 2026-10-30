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
import { applyOp } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import type { Op } from '../../core/dag/types';
import { linkIntoActiveCollection } from '../collections';
import { DEFAULT_CAMERA_FAR, DEFAULT_CAMERA_NEAR } from '../../nodes/CameraData';
import { cutChannelOf } from '../activeCamera';
import { buildCutOps } from '../shotOps';
import { nodeDisplayName } from '../sceneTreeWalk';
import { useTimeStore } from '../stores/timeStore';
import { useNotificationStore } from '../stores/notificationStore';

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

  // #1667 — once a scene has several cameras, `Scene.camera` is fed by a CameraSelect whose keyed
  // `active` holds the film's cuts. Re-routing `Scene.camera` to the new camera unhooked that
  // switch, and every cut silently stopped playing. With a switch in place the new camera joins
  // its list and becomes the active one instead — what the outliner's Set Active does — so the
  // switch, and the cuts on it, stay wired. A directly wired camera is still replaced: the old
  // one stays in the scene, unwired, as every camera that is not active sits (#1630).
  const select = existing ? state.nodes[existing.node] : undefined;
  const switchId = select?.type === 'CameraSelect' ? select.id : null;
  const ops: Op[] = [];
  if (existing && !switchId) {
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
      near: DEFAULT_CAMERA_NEAR,
      far: DEFAULT_CAMERA_FAR,
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
  // #1690 — with cuts on the switch, the keys pick the camera and `active` alone would never be on
  // screen: the new view would be made and never shown. So it is cut to at the playhead, which is
  // Blender's Bind Camera to Markers (a marker at the current frame, made if none is there, bound
  // to the camera). A cut already at the playhead is that shot, and it now films from the new view.
  const channel = switchId ? cutChannelOf(state, switchId) : null;
  let told: string | null = null;
  if (switchId && channel) {
    let s = state;
    for (const op of ops) s = applyOp(s, op).next;
    const at = useTimeStore.getState().filmSeconds;
    const cut = buildCutOps(s, at, newId);
    if (!cut) return;
    ops.push(...cut);
    const keys = (channel.params as { keyframes?: { time: number }[] }).keyframes ?? [];
    const name = nodeDisplayName(s.nodes, newId);
    told = keys.some((k) => k.time === at)
      ? `The shot at ${at.toFixed(2)} s now films from ${name}`
      : `Cut to ${name} at ${at.toFixed(2)} s`;
  } else if (switchId) {
    ops.push({
      type: 'connect',
      from: { node: newId, socket: 'out' },
      to: { node: switchId, socket: 'cameras' },
    });
    // #1668 — `active` names the camera it shows.
    ops.push({ type: 'setParam', nodeId: switchId, paramPath: 'active', value: newId });
  } else {
    ops.push({
      type: 'connect',
      from: { node: newId, socket: 'out' },
      to: { node: sceneRef.node, socket: 'camera' },
    });
  }

  // #1504 — into the active collection, as the Add menu's cameras join it (#1453).
  dag.dispatchAtomic(linkIntoActiveCollection(state, ops, [newId]), 'user', 'camera-from-view');
  if (told) useNotificationStore.getState().notify({ severity: 'success', message: told });
}

// cameraFromView — verify the macro emits the expected atomic 3-op chain
// when an existing camera is wired (disconnect → addNode → connect).
//
// Drives the macro through the same store/threeRef interface the production
// keyboard shortcut and menu item use. The bridge between R3F and the
// editor camera is mocked via useThreeRef.setState — the macro reads
// position + target via the store, not via useThree(), exactly so this is
// testable outside the Canvas (V8 file-rooted, threeRef.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp, emptyDagState } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { makeSplitCamera } from '../../test-utils/splitCamera';
import { registerAllNodes } from '../../nodes/registerAll';
import { snapshotCameraFromOrbit } from './cameraFromView';
import { useThreeRef } from './threeRef';
import { buildSetActiveCameraOps } from '../setActiveCamera';
import { selectActiveCameraNode } from '../activeCamera';

beforeEach(() => {
  registerAllNodes();
  // The already-wired camera the macro has to disconnect from. It was a hand-written fused
  // `PerspectiveCamera` state literal until #599 deleted that type; it is built through the
  // canonical split helper now, which is not merely a substitution — an existing camera in a
  // real project IS an Object → CameraData pair, and that is the shape the macro's disconnect
  // arm actually meets. The macro's OUTPUT was already asserted to be a pair below, so the
  // fixture and the subject now agree about what a camera is.
  let seed = applyOp(emptyDagState(), {
    type: 'addNode',
    nodeId: 'scene',
    nodeType: 'Scene',
    params: {},
  }).next;
  seed = makeSplitCamera(seed, {
    objectId: 'cam',
    fov: 45,
    position: [0, 0, 5],
    lens: { near: 0.1, far: 1000, lookAt: [0, 0, 0] },
    connectTo: { node: 'scene', socket: 'camera' },
  }).state;
  useDagStore.getState().hydrate({
    nodes: seed.nodes,
    outputs: { scene: { node: 'scene', socket: 'out' } },
  });
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  cam.position.set(2, 3, 4);
  useThreeRef.setState({
    camera: cam,
    controlsTarget: new THREE.Vector3(1, 0, 0),
  });
});

describe('snapshotCameraFromOrbit', () => {
  it('emits disconnect → addNode → connect; new camera replaces scene.camera; one undo reverts all', async () => {
    const before = Object.keys(useDagStore.getState().state.nodes).length;
    await snapshotCameraFromOrbit();
    const after = useDagStore.getState();
    // #387 C4 — a snapshot now mints the object↔data PAIR, so TWO nodes appear.
    expect(Object.keys(after.state.nodes).length).toBe(before + 2);

    // The Scene's camera input now points to a NEW camera OBJECT (the posable half).
    const sceneCam = after.state.nodes.scene.inputs.camera;
    expect(sceneCam).toBeDefined();
    if (Array.isArray(sceneCam)) throw new Error('camera is single-cardinality');
    expect(sceneCam!.node).not.toBe('cam');
    const newCamNode = after.state.nodes[sceneCam!.node];
    expect(newCamNode.type).toBe('Object');
    // The POSE the orbit camera was sitting at lands on the Object...
    expect(newCamNode.params).toMatchObject({ position: [2, 3, 4] });
    // ...and the LENS it was wearing lands on the CameraData it points at. Asserted through
    // the `data` edge rather than by id, so a pair that was minted but never wired reds.
    const dataRef = newCamNode.inputs.data;
    expect(dataRef).toBeDefined();
    if (Array.isArray(dataRef)) throw new Error('data is single-cardinality');
    const lensNode = after.state.nodes[dataRef!.node];
    expect(lensNode.type).toBe('CameraData');
    expect(lensNode.params).toMatchObject({
      projection: 'Perspective',
      fov: 45,
      lookAt: [1, 0, 0],
    });

    // The atomic group means ONE undo reverts the whole snapshot.
    expect(after.undoStack.length).toBe(1);
    after.undo();
    const reverted = useDagStore.getState();
    expect(Object.keys(reverted.state.nodes).length).toBe(before);
    expect(reverted.state.nodes.scene.inputs.camera).toEqual({ node: 'cam', socket: 'out' });
  });

  it('#1667 — with a camera switch, the new camera joins it and the cuts keep playing', async () => {
    // Two cameras under a switch, with a cut to the second at 2 s.
    let s = useDagStore.getState().state;
    s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
    for (const op of buildSetActiveCameraOps(s, 'cam2') ?? []) s = applyOp(s, op).next;
    for (const op of buildSetActiveCameraOps(s, 'cam') ?? []) s = applyOp(s, op).next;
    const sel = (s.nodes.scene.inputs.camera as { node: string }).node;
    expect(s.nodes[sel].type).toBe('CameraSelect');
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'active',
        target: sel,
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 0, easing: 'constant' },
          { time: 2, value: 1, easing: 'constant' },
        ],
      },
    }).next;
    useDagStore.getState().hydrate({ nodes: s.nodes, outputs: s.outputs });

    await snapshotCameraFromOrbit();
    const after = useDagStore.getState();
    // The switch still feeds the scene's camera...
    expect(after.state.nodes.scene.inputs.camera).toEqual({ node: sel, socket: 'out' });
    // ...the new camera is the third in its list, and the active one when nothing is keyed...
    const listed = (after.state.nodes[sel].inputs.cameras as { node: string }[]).map((r) => r.node);
    expect(listed).toHaveLength(3);
    const fresh = listed[2];
    expect(after.state.nodes[fresh].params).toMatchObject({ position: [2, 3, 4] });
    expect(after.state.nodes[sel].params.active).toBe(2);
    // ...and the keyed cut still plays: camera 1 before 2 s, camera 2 from it.
    expect(selectActiveCameraNode(after.state, 1)?.id).toBe(listed[0]);
    expect(selectActiveCameraNode(after.state, 2)?.id).toBe('cam2');
    // One undo.
    expect(after.undoStack.length).toBe(1);
  });

  it('no-op when no editor camera is available', async () => {
    useThreeRef.setState({ camera: null, controlsTarget: null });
    const before = useDagStore.getState();
    await snapshotCameraFromOrbit();
    const after = useDagStore.getState();
    expect(Object.keys(after.state.nodes).length).toBe(Object.keys(before.state.nodes).length);
    expect(after.undoStack.length).toBe(before.undoStack.length);
  });
});

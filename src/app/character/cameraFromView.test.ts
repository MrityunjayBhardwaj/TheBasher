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
import { useTimeStore } from '../stores/timeStore';
import { useNotificationStore } from '../stores/notificationStore';

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
  useTimeStore.getState().setTime(0);
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

  /** Two cameras under a switch with a cut to the second at 2 s; returns the switch and both ids. */
  function filmWithCut(): { sel: string; first: string; second: string } {
    let s = useDagStore.getState().state;
    s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
    for (const op of buildSetActiveCameraOps(s, 'cam2') ?? []) s = applyOp(s, op).next;
    for (const op of buildSetActiveCameraOps(s, 'cam') ?? []) s = applyOp(s, op).next;
    const sel = (s.nodes.scene.inputs.camera as { node: string }).node;
    expect(s.nodes[sel].type).toBe('CameraSelect');
    const [first, second] = (s.nodes[sel].inputs.cameras as { node: string }[]).map((r) => r.node);
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'cuts',
      nodeType: 'KeyframeChannelText',
      params: {
        name: 'active',
        target: sel,
        paramPath: 'active',
        keyframes: [
          { time: 0, value: first, easing: 'constant' },
          { time: 2, value: second, easing: 'constant' },
        ],
      },
    }).next;
    useDagStore.getState().hydrate({ nodes: s.nodes, outputs: s.outputs });
    return { sel, first, second };
  }

  const cutTimes = () =>
    (
      useDagStore.getState().state.nodes.cuts.params as { keyframes: { time: number }[] }
    ).keyframes.map((k) => k.time);

  it('#1667 + #1690 — with cuts, the new camera joins the switch and is cut to at the playhead', async () => {
    const { sel, first, second } = filmWithCut();
    const activeBefore = useDagStore.getState().state.nodes[sel].params.active;
    useTimeStore.getState().setTime(1);

    await snapshotCameraFromOrbit();
    const after = useDagStore.getState();
    // The switch still feeds the scene's camera, and the new camera is the third in its list...
    expect(after.state.nodes.scene.inputs.camera).toEqual({ node: sel, socket: 'out' });
    const listed = (after.state.nodes[sel].inputs.cameras as { node: string }[]).map((r) => r.node);
    expect(listed).toHaveLength(3);
    const fresh = listed[2];
    expect(after.state.nodes[fresh].params).toMatchObject({ position: [2, 3, 4] });
    // ...it is ON SCREEN from the playhead to the next cut, and the cuts around it still play.
    expect(selectActiveCameraNode(after.state, 0.5)?.id).toBe(first);
    expect(selectActiveCameraNode(after.state, 1.5)?.id).toBe(fresh);
    expect(selectActiveCameraNode(after.state, 2.5)?.id).toBe(second);
    expect(cutTimes()).toEqual([0, 1, 2]);
    // The switch's own camera is left alone: the cut is what shows the new view.
    expect(after.state.nodes[sel].params.active).toBe(activeBefore);
    // It says what it did, and it is one undo.
    expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
      /^Cut to .+ at 1\.00 s$/,
    );
    expect(after.undoStack.length).toBe(1);
    after.undo();
    expect(cutTimes()).toEqual([0, 2]);
  });

  it('#1690 — with the playhead on a cut, that shot films from the new view', async () => {
    const { sel, first } = filmWithCut();
    useTimeStore.getState().setTime(2);
    await snapshotCameraFromOrbit();
    const after = useDagStore.getState().state;
    const fresh = (after.nodes[sel].inputs.cameras as { node: string }[]).map((r) => r.node)[2];
    expect(cutTimes()).toEqual([0, 2]);
    expect(selectActiveCameraNode(after, 1)?.id).toBe(first);
    expect(selectActiveCameraNode(after, 2.5)?.id).toBe(fresh);
    expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
      /^The shot at 2\.00 s now films from /,
    );
  });

  it('#1667 — with a switch and no cuts, the new camera becomes the active one', async () => {
    let s = useDagStore.getState().state;
    s = makeSplitCamera(s, { objectId: 'cam2', position: [20, 0, 0] }).state;
    for (const op of buildSetActiveCameraOps(s, 'cam2') ?? []) s = applyOp(s, op).next;
    useDagStore.getState().hydrate({ nodes: s.nodes, outputs: s.outputs });
    const sel = (s.nodes.scene.inputs.camera as { node: string }).node;
    const toasts = useNotificationStore.getState().toasts.length;
    await snapshotCameraFromOrbit();
    const after = useDagStore.getState().state;
    const listed = (after.nodes[sel].inputs.cameras as { node: string }[]).map((r) => r.node);
    expect(after.nodes[sel].params.active).toBe(listed.at(-1));
    expect(selectActiveCameraNode(after, 3)?.id).toBe(listed.at(-1));
    expect(useNotificationStore.getState().toasts.length).toBe(toasts);
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

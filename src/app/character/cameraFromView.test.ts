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
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import { snapshotCameraFromOrbit } from './cameraFromView';
import { useThreeRef } from './threeRef';

beforeEach(() => {
  registerAllNodes();
  useDagStore.getState().hydrate({
    nodes: {
      cam: {
        id: 'cam',
        type: 'PerspectiveCamera',
        version: 1,
        params: { fov: 45, near: 0.1, far: 1000, position: [0, 0, 5], lookAt: [0, 0, 0] },
        inputs: {},
      },
      scene: {
        id: 'scene',
        type: 'Scene',
        version: 1,
        params: {},
        inputs: {
          camera: { node: 'cam', socket: 'out' },
          children: [],
          lights: [],
        },
      },
    },
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
    expect(Object.keys(after.state.nodes).length).toBe(before + 1);

    // The Scene's camera input now points to a NEW PerspectiveCamera node.
    const sceneCam = after.state.nodes.scene.inputs.camera;
    expect(sceneCam).toBeDefined();
    if (Array.isArray(sceneCam)) throw new Error('camera is single-cardinality');
    expect(sceneCam!.node).not.toBe('cam');
    const newCamNode = after.state.nodes[sceneCam!.node];
    expect(newCamNode.type).toBe('PerspectiveCamera');
    expect(newCamNode.params).toMatchObject({
      fov: 45,
      position: [2, 3, 4],
      lookAt: [1, 0, 0],
    });

    // The atomic group means ONE undo reverts the whole snapshot.
    expect(after.undoStack.length).toBe(1);
    after.undo();
    const reverted = useDagStore.getState();
    expect(Object.keys(reverted.state.nodes).length).toBe(before);
    expect(reverted.state.nodes.scene.inputs.camera).toEqual({ node: 'cam', socket: 'out' });
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

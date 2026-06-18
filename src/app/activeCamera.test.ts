// activeCamera — locate the scene's active camera node + read its pose.
// Drives the editor view camera (#165): boot framing + look-through adopt.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraPoseFromNode,
  DEFAULT_CAMERA_POSE,
  resolveActiveCameraPose,
  resolveActiveCameraPoseAt,
  selectActiveCameraNode,
} from './activeCamera';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Node } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

// buildDefaultDagState / applyOp resolve node types from the registry, which
// is populated by registerAll (a side-effecting boot step in the real app).
beforeAll(() => {
  __reseedAllNodesForTests();
});

describe('activeCamera — selectActiveCameraNode', () => {
  it('finds the camera node wired into scene.camera (default project)', () => {
    const state = buildDefaultDagState();
    const node = selectActiveCameraNode(state);
    expect(node).not.toBeNull();
    expect(node?.id).toBe('n_camera');
    expect(node?.type).toBe('PerspectiveCamera');
  });

  it('returns null when no scene output is declared', () => {
    expect(selectActiveCameraNode(emptyDagState())).toBeNull();
  });

  it('returns null when the scene has no camera wired', () => {
    // Build a scene with no camera connection.
    let state: DagState = emptyDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_scene',
      nodeType: 'Scene',
      params: {},
    }).next;
    state = { ...state, outputs: { scene: { node: 'n_scene', socket: 'out' } } };
    expect(selectActiveCameraNode(state)).toBeNull();
  });
});

describe('activeCamera — cameraPoseFromNode', () => {
  it('reads pose from the default seed camera (matches default.ts)', () => {
    const state = buildDefaultDagState();
    const pose = cameraPoseFromNode(selectActiveCameraNode(state));
    expect(pose).toEqual({
      kind: 'PerspectiveCamera',
      position: [3, 2, 3],
      lookAt: [0, 0, 0],
      fov: 45,
      near: 0.1,
      far: 1000,
    });
  });

  it('returns null for a null node', () => {
    expect(cameraPoseFromNode(null)).toBeNull();
  });

  it('defends against missing params with the default pose values', () => {
    const node = { id: 'c', type: 'PerspectiveCamera', params: {}, inputs: {} } as unknown as Node;
    const pose = cameraPoseFromNode(node);
    expect(pose).toEqual(DEFAULT_CAMERA_POSE);
  });

  it('tags an OrthographicCamera node with the ortho kind', () => {
    const node = {
      id: 'c',
      type: 'OrthographicCamera',
      params: { position: [1, 2, 3], lookAt: [0, 1, 0], near: 0.5, far: 50 },
      inputs: {},
    } as unknown as Node;
    const pose = cameraPoseFromNode(node);
    expect(pose?.kind).toBe('OrthographicCamera');
    expect(pose?.position).toEqual([1, 2, 3]);
    expect(pose?.lookAt).toEqual([0, 1, 0]);
  });
});

describe('activeCamera — resolveActiveCameraPose', () => {
  it('falls back to DEFAULT_CAMERA_POSE when no camera is present', () => {
    expect(resolveActiveCameraPose(emptyDagState())).toEqual(DEFAULT_CAMERA_POSE);
  });

  it('returns the seed camera pose for the default project', () => {
    expect(resolveActiveCameraPose(buildDefaultDagState()).position).toEqual([3, 2, 3]);
  });
});

describe('activeCamera — resolveActiveCameraPoseAt (#190)', () => {
  // Add a KeyframeChannel* node targeting the default project's camera node.
  function addChannel(
    state: DagState,
    nodeType: 'KeyframeChannelVec3' | 'KeyframeChannelNumber',
    paramPath: string,
    keyframes: unknown[],
    target = 'n_camera',
    nodeId = `ch_${paramPath}`,
  ): DagState {
    return applyOp(state, {
      type: 'addNode',
      nodeId,
      nodeType,
      params: { name: paramPath, target, paramPath, keyframes },
    }).next;
  }

  it('returns the static base pose unchanged when the camera is unanimated', () => {
    const state = buildDefaultDagState();
    // Byte-identical to the static read at any time — a safe drop-in.
    expect(resolveActiveCameraPoseAt(state, 0)).toEqual(resolveActiveCameraPose(state));
    expect(resolveActiveCameraPoseAt(state, 5)).toEqual(resolveActiveCameraPose(state));
  });

  it('overlays a position channel, interpolating linearly between keys', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelVec3', 'position', [
      { time: 0, value: [0, 0, 0], easing: 'linear' },
      { time: 1, value: [10, 0, 0], easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([0, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([10, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 0.5).position).toEqual([5, 0, 0]);
    // Non-keyed params keep the base.
    expect(resolveActiveCameraPoseAt(state, 0.5).lookAt).toEqual([0, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 0.5).fov).toBe(45);
  });

  it('overlays a scalar fov channel', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', [
      { time: 0, value: 20, easing: 'linear' },
      { time: 2, value: 60, easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(20);
    expect(resolveActiveCameraPoseAt(state, 1).fov).toBe(40);
    expect(resolveActiveCameraPoseAt(state, 2).fov).toBe(60);
  });

  it('sorts a scalar channel before sampling, matching the inspector read-side (#200)', () => {
    // The SAME two keys as above, authored OUT OF TIME ORDER. The render path
    // (`sampleScalarKeyframes`) requires a sorted list, and the inspector
    // read-side (`KeyframeChannelNumber.evaluate` → `.sample`) sorts defensively,
    // so the two must agree only if THIS resolver also sorts. Falsifiable: revert
    // the #200 sort → `sampleScalarKeyframes` clamps to the first (now time=2)
    // key, so t=1 returns 60 instead of the correctly-interpolated 40.
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', [
      { time: 2, value: 60, easing: 'linear' },
      { time: 0, value: 20, easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(20);
    expect(resolveActiveCameraPoseAt(state, 1).fov).toBe(40);
    expect(resolveActiveCameraPoseAt(state, 2).fov).toBe(60);
  });

  it('overlays position + lookAt + fov channels together at the same time', () => {
    let state = buildDefaultDagState();
    state = addChannel(
      state,
      'KeyframeChannelVec3',
      'position',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [2, 4, 6], easing: 'linear' },
      ],
      'n_camera',
      'ch_pos',
    );
    state = addChannel(
      state,
      'KeyframeChannelVec3',
      'lookAt',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [1, 1, 1], easing: 'linear' },
      ],
      'n_camera',
      'ch_look',
    );
    state = addChannel(
      state,
      'KeyframeChannelNumber',
      'fov',
      [
        { time: 0, value: 30, easing: 'linear' },
        { time: 1, value: 50, easing: 'linear' },
      ],
      'n_camera',
      'ch_fov',
    );
    const pose = resolveActiveCameraPoseAt(state, 1);
    expect(pose.position).toEqual([2, 4, 6]);
    expect(pose.lookAt).toEqual([1, 1, 1]);
    expect(pose.fov).toBe(50);
    // near/far untouched → base.
    expect(pose.near).toBe(0.1);
    expect(pose.far).toBe(1000);
  });

  it('ignores channels that target a different node', () => {
    const state = addChannel(
      buildDefaultDagState(),
      'KeyframeChannelVec3',
      'position',
      [
        { time: 0, value: [0, 0, 0], easing: 'linear' },
        { time: 1, value: [99, 99, 99], easing: 'linear' },
      ],
      'some_other_node',
    );
    // The camera is unanimated → base pose despite the foreign channel.
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([3, 2, 3]);
  });

  it('does not let an empty-keyframe channel clobber the base pose', () => {
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'fov', []);
    expect(resolveActiveCameraPoseAt(state, 0).fov).toBe(45); // base, not 0
  });

  it('returns DEFAULT_CAMERA_POSE for a camera-less scene at any time', () => {
    expect(resolveActiveCameraPoseAt(emptyDagState(), 3)).toEqual(DEFAULT_CAMERA_POSE);
  });
});

// activeCamera — locate the scene's active camera node + read its pose.
// Drives the editor view camera (#165): boot framing + look-through adopt.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraPoseFromNode,
  DEFAULT_CAMERA_POSE,
  resolveActiveCameraPose,
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

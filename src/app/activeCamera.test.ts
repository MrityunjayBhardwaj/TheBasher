// activeCamera — locate the scene's active camera node + read its pose.
// Drives the editor view camera (#165): boot framing + look-through adopt.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraPoseFromNode,
  DEFAULT_CAMERA_POSE,
  resolveActiveCameraPose,
  resolveActiveCameraPoseAt,
  resolveCameraFrustumPose,
  selectActiveCameraNode,
} from './activeCamera';
import { buildDefaultDagState } from '../core/project/default';
import { applyOp, emptyDagState, type DagState } from '../core/dag';
import type { Node } from '../core/dag/types';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';

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

// #231 Inc 3 — the multi-camera "active" model. A CameraSelect feeds scene.camera;
// `selectActiveCameraNode` resolves THROUGH it to the active camera node (by index,
// keyframeable → cuts). A direct-wired camera (every pre-change project) still
// resolves to itself — the fallback, no migration.
describe('activeCamera — CameraSelect resolve-through (#231 Inc 3)', () => {
  /** Default project + a 2nd camera + a CameraSelect wired into scene.camera.
   *  cameras edge order: [n_camera (idx 0), n_cam2 (idx 1)]. */
  function buildMultiCamera(active = 0): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cam2',
      nodeType: 'PerspectiveCamera',
      params: { position: [10, 0, 0], lookAt: [0, 0, 0], fov: 60 },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_camsel',
      nodeType: 'CameraSelect',
      params: { active },
    }).next;
    // Edge order defines the index (V44): n_camera first, then n_cam2.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_camera', socket: 'out' },
      to: { node: 'n_camsel', socket: 'cameras' },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_camsel', socket: 'cameras' },
    }).next;
    // Single-cardinality scene.camera → this REPLACES the direct n_camera wiring.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_camsel', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
    }).next;
    return state;
  }

  it('resolves through CameraSelect to the active camera node (active:0)', () => {
    const node = selectActiveCameraNode(buildMultiCamera(0));
    expect(node?.id).toBe('n_camera');
  });

  it('resolves to the 2nd camera when active:1', () => {
    const node = selectActiveCameraNode(buildMultiCamera(1));
    expect(node?.id).toBe('n_cam2');
  });

  it('clamps an out-of-range active to the last camera (matches the value side)', () => {
    const node = selectActiveCameraNode(buildMultiCamera(9));
    expect(node?.id).toBe('n_cam2');
  });

  it('the resolved active camera drives the pose', () => {
    // active:1 → n_cam2 at [10,0,0] with fov 60.
    const pose = resolveActiveCameraPose(buildMultiCamera(1));
    expect(pose.position).toEqual([10, 0, 0]);
    expect(pose.fov).toBe(60);
  });

  it('a direct-wired camera (no CameraSelect) still resolves — the fallback', () => {
    // The default project wires n_camera DIRECTLY; unchanged.
    expect(selectActiveCameraNode(buildDefaultDagState())?.id).toBe('n_camera');
  });

  it('CUTS the pose between cameras when `active` is keyframed (camera cut)', () => {
    let state = buildMultiCamera(0);
    // Keyframe the CameraSelect's `active` index 0→1 over [0,1]s.
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_active',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'active',
        target: 'n_camsel',
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    // At t=0 the live camera is n_camera ([3,2,3]); at t=1 it cuts to n_cam2
    // ([10,0,0]). The pose resolver reads the active camera AT that time.
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([3, 2, 3]);
    expect(resolveActiveCameraPoseAt(state, 1).position).toEqual([10, 0, 0]);
    // Mid-interpolation rounds: 0.4 → still camera 0, 0.6 → camera 1 (the cut snaps).
    expect(resolveActiveCameraPoseAt(state, 0.4).position).toEqual([3, 2, 3]);
    expect(resolveActiveCameraPoseAt(state, 0.6).position).toEqual([10, 0, 0]);
  });

  it('the STATIC selector (no seconds) ignores the keyframed active — editor "now"', () => {
    let state = buildMultiCamera(0);
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_active',
      nodeType: 'KeyframeChannelNumber',
      params: {
        name: 'active',
        target: 'n_camsel',
        paramPath: 'active',
        keyframes: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 1, value: 1, easing: 'linear' },
        ],
      },
    }).next;
    // selectActiveCameraNode WITHOUT seconds → static param (0) → n_camera.
    expect(selectActiveCameraNode(state)?.id).toBe('n_camera');
    // WITH seconds=1 → the cut camera.
    expect(selectActiveCameraNode(state, 1)?.id).toBe('n_cam2');
  });
});

// #231 Inc 3.3 — a camera nested in a Group frames from the group-composed WORLD.
describe('activeCamera — nested camera world pose (#231 Inc 3.3)', () => {
  /** Default project + a Group@[gx,gy,gz] in scene.children + a 2nd camera nested
   *  in that Group's children AND wired active into scene.camera. */
  function buildNestedActiveCamera(group: [number, number, number]): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_grp',
      nodeType: 'Group',
      params: { position: group },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_grp', socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    }).next;
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cam2',
      nodeType: 'PerspectiveCamera',
      params: { position: [0, 0, 0], lookAt: [0, 0, -1], fov: 50 },
    }).next;
    // Nest the camera under the Group.
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_grp', socket: 'children' },
    }).next;
    // Make it the active camera (replace the seed direct wire on the single socket).
    state = applyOp(state, {
      type: 'connect',
      from: { node: 'n_cam2', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
    }).next;
    return state;
  }

  it('the active nested camera pose is lifted by the group world', () => {
    const pose = resolveActiveCameraPoseAt(buildNestedActiveCamera([5, 1, 0]), 0);
    // local position [0,0,0] under Group@[5,1,0] → world [5,1,0].
    expect(pose.position[0]).toBeCloseTo(5);
    expect(pose.position[1]).toBeCloseTo(1);
    expect(pose.position[2]).toBeCloseTo(0);
    // local lookAt [0,0,-1] translated by the group → [5,1,-1] (aim preserved).
    expect(pose.lookAt[0]).toBeCloseTo(5);
    expect(pose.lookAt[1]).toBeCloseTo(1);
    expect(pose.lookAt[2]).toBeCloseTo(-1);
  });

  it('a top-level (un-nested) active camera is unchanged (byte-identical fallback)', () => {
    // Default project: n_camera wired direct, not in any Group.
    const pose = resolveActiveCameraPoseAt(buildDefaultDagState(), 0);
    expect(pose.position).toEqual([3, 2, 3]);
    expect(pose.lookAt).toEqual([0, 0, 0]);
  });

  it('the frustum pose helper lifts a nested camera the same way', () => {
    const state = buildNestedActiveCamera([5, 1, 0]);
    const pose = resolveCameraFrustumPose(state, 'n_cam2', {
      time: { frame: 0, seconds: 0, normalized: 0 },
    });
    expect(pose?.position[0]).toBeCloseTo(5);
    expect(pose?.position[1]).toBeCloseTo(1);
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
      near: 0.01,
      far: 500,
      roll: 0,
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

  it('overlays a scalar roll channel (#229)', () => {
    expect(resolveActiveCameraPose(buildDefaultDagState()).roll).toBe(0); // base default
    const state = addChannel(buildDefaultDagState(), 'KeyframeChannelNumber', 'roll', [
      { time: 0, value: 0, easing: 'linear' },
      { time: 2, value: 90, easing: 'linear' },
    ]);
    expect(resolveActiveCameraPoseAt(state, 0).roll).toBe(0);
    expect(resolveActiveCameraPoseAt(state, 1).roll).toBe(45);
    expect(resolveActiveCameraPoseAt(state, 2).roll).toBe(90);
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
    expect(pose.near).toBe(0.01);
    expect(pose.far).toBe(500);
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

// #204 — the camera migration onto Track-To. A constraint on the camera node
// DERIVES its lookAt from the target (V60), through the SAME machinery meshes use.
describe('activeCamera — Track-To migration (#204)', () => {
  /** Default project + a target box (the aim node) + a Track-To on n_camera. */
  function buildCameraTrackTo(opts: { aimNode?: string; aimPoint?: [number, number, number] }) {
    let state = buildDefaultDagState();
    if (opts.aimNode) {
      state = makeSplitCube(state, {
        objectId: opts.aimNode,
        position: [7, 0, 0],
        size: [1, 1, 1],
      }).state;
      state = applyOp(state, {
        type: 'connect',
        from: { node: opts.aimNode, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      }).next;
    }
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cam_tt',
      nodeType: 'TrackTo',
      params: {
        name: 'camtt',
        target: 'n_camera',
        aimNode: opts.aimNode ?? '',
        aimPoint: opts.aimPoint ?? [0, 0, 0],
        up: [0, 1, 0],
        mute: false,
      },
    }).next;
    return state;
  }

  it('derives the camera lookAt from a node-ref target world position', () => {
    const state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    // lookAt is no longer the static [0,0,0] param — it tracks the box at [7,0,0].
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([7, 0, 0]);
    // position is untouched (Track-To only aims).
    expect(resolveActiveCameraPoseAt(state, 0).position).toEqual([3, 2, 3]);
  });

  it('the camera lookAt follows a MOVING target over time', () => {
    let state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'ch_target',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'tgt',
        target: 'n_cam_target',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [7, 0, 0], easing: 'linear' },
          { time: 1, value: [0, 0, 7], easing: 'linear' },
        ],
      },
    }).next;
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([7, 0, 0]);
    expect(resolveActiveCameraPoseAt(state, 1).lookAt).toEqual([0, 0, 7]);
  });

  it('a point-target Track-To overrides the static lookAt', () => {
    const state = buildCameraTrackTo({ aimPoint: [1, 2, 3] });
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([1, 2, 3]);
  });

  it('a muted camera Track-To leaves the static lookAt untouched', () => {
    let state = buildCameraTrackTo({ aimNode: 'n_cam_target' });
    state = applyOp(state, {
      type: 'setParam',
      nodeId: 'n_cam_tt',
      paramPath: 'mute',
      value: true,
    }).next;
    // Byte-identical to the unconstrained base pose.
    expect(resolveActiveCameraPoseAt(state, 0).lookAt).toEqual([0, 0, 0]);
  });
});

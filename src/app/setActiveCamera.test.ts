// buildSetActiveCameraOps tests (#231 Inc 3.2). The lazy CameraSelect lifecycle:
// single camera → direct wire; 2+ cameras + set-active a non-active one → a
// CameraSelect materializes; once present → setParam active. Each case applies the
// built ops and asserts the RESOLVED active camera (selectActiveCameraNode), so
// the action is proven end-to-end against the resolver, not just by op shape.

import { beforeAll, describe, expect, it } from 'vitest';
import { applyOp, type DagState } from '../core/dag';
import { buildDefaultDagState } from '../core/project/default';
import { selectActiveCameraNode } from './activeCamera';
import { buildSetActiveCameraOps } from './setActiveCamera';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

beforeAll(() => {
  __reseedAllNodesForTests();
});

function applyAll(state: DagState, ops: ReturnType<typeof buildSetActiveCameraOps>): DagState {
  let s = state;
  for (const op of ops ?? []) s = applyOp(s, op).next;
  return s;
}

/** Default project (n_camera wired direct) + an Nth extra camera node (floating). */
function addCamera(state: DagState, id: string, position: [number, number, number]): DagState {
  return applyOp(state, {
    type: 'addNode',
    nodeId: id,
    nodeType: 'PerspectiveCamera',
    params: { position, lookAt: [0, 0, 0], fov: 50 },
  }).next;
}

describe('buildSetActiveCameraOps', () => {
  it('returns null when the camera is already active (no churn)', () => {
    const state = buildDefaultDagState();
    expect(buildSetActiveCameraOps(state, 'n_camera')).toBeNull();
  });

  it('returns null for a non-camera node id', () => {
    const state = buildDefaultDagState();
    // n_scene is a Scene, not a camera.
    expect(buildSetActiveCameraOps(state, 'n_scene')).toBeNull();
  });

  it('a single floating camera set active → wired DIRECTLY (no CameraSelect)', () => {
    // Start from a scene whose camera is the only one; set-active a DIFFERENT
    // single camera by first removing the seed wire is overkill — instead prove
    // the ≤1-camera branch: a scene with one camera, re-point to it directly.
    // Build a fresh scene with exactly one (floating) camera and no wired camera.
    let state = buildDefaultDagState();
    // Disconnect the seed camera so the scene has a floating single camera.
    state = applyOp(state, {
      type: 'disconnect',
      from: { node: 'n_camera', socket: 'out' },
      to: { node: 'n_scene', socket: 'camera' },
    }).next;
    expect(selectActiveCameraNode(state)).toBeNull();
    const ops = buildSetActiveCameraOps(state, 'n_camera');
    expect(ops).not.toBeNull();
    // No CameraSelect was created (only one camera).
    expect(ops!.some((o) => o.type === 'addNode')).toBe(false);
    const next = applyAll(state, ops);
    expect(selectActiveCameraNode(next)?.id).toBe('n_camera');
  });

  it('2+ cameras: set-active a non-active one → lazily inserts a CameraSelect', () => {
    let state = buildDefaultDagState();
    state = addCamera(state, 'n_cam2', [10, 0, 0]);
    // Before: direct-wired n_camera is active.
    expect(selectActiveCameraNode(state)?.id).toBe('n_camera');
    const ops = buildSetActiveCameraOps(state, 'n_cam2');
    expect(ops).not.toBeNull();
    // A CameraSelect was created and wired.
    const added = ops!.find((o) => o.type === 'addNode');
    expect(added && 'nodeType' in added ? added.nodeType : null).toBe('CameraSelect');
    const next = applyAll(state, ops);
    // The resolver now reports n_cam2 as active.
    expect(selectActiveCameraNode(next)?.id).toBe('n_cam2');
    // And n_camera is still selectable as active (it's in the selector).
    expect(
      selectActiveCameraNode(applyAll(next, buildSetActiveCameraOps(next, 'n_camera')))?.id,
    ).toBe('n_camera');
  });

  it('once a CameraSelect exists, set-active is just a setParam (no new node)', () => {
    let state = buildDefaultDagState();
    state = addCamera(state, 'n_cam2', [10, 0, 0]);
    state = applyAll(state, buildSetActiveCameraOps(state, 'n_cam2')); // creates select
    state = addCamera(state, 'n_cam3', [0, 0, 10]); // a 3rd, not yet in selector
    const ops = buildSetActiveCameraOps(state, 'n_camera');
    expect(ops!.every((o) => o.type !== 'addNode')).toBe(true); // reuses the selector
    expect(selectActiveCameraNode(applyAll(state, ops))?.id).toBe('n_camera');
  });

  it('set-active a camera NOT yet in the selector → connects it, then activates', () => {
    let state = buildDefaultDagState();
    state = addCamera(state, 'n_cam2', [10, 0, 0]);
    state = applyAll(state, buildSetActiveCameraOps(state, 'n_cam2')); // select holds n_camera+n_cam2
    state = addCamera(state, 'n_cam3', [0, 5, 0]); // floating, not in selector
    const ops = buildSetActiveCameraOps(state, 'n_cam3');
    // It connects n_cam3 into the selector (a connect op) then setParam active.
    expect(ops!.some((o) => o.type === 'connect')).toBe(true);
    expect(ops!.some((o) => o.type === 'setParam')).toBe(true);
    const next = applyAll(state, ops);
    expect(selectActiveCameraNode(next)?.id).toBe('n_cam3');
  });

  it('the built ops are one atomic, reversible batch (the resolver flips back on undo-equivalent)', () => {
    let state = buildDefaultDagState();
    state = addCamera(state, 'n_cam2', [10, 0, 0]);
    const next = applyAll(state, buildSetActiveCameraOps(state, 'n_cam2'));
    // Set back to n_camera via the SAME action (idempotent round-trip).
    const back = applyAll(next, buildSetActiveCameraOps(next, 'n_camera'));
    expect(selectActiveCameraNode(back)?.id).toBe('n_camera');
  });
});

// stripDrive — the ONE predicate the picker, the push-down button and the push-down
// dispatcher all consume (#479). Tested here on its own contract, because that is the
// only surface where its two answers are distinguishable: at a consumer, "refused" and
// "there was nothing to do" can look identical.
//
// EXPIRES WITH #480 — when the camera scan folds onto the shared strip seam, cameras
// become drivable and this file goes with the module it tests.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { stripDriveRefusal } from './stripDrive';
import { stripTargetRows } from '../timeline/NlaAddStripPopover';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

/** scene ← box, plus a camera wired into `scene.camera`. */
function buildScene(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { name: 'Box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = { ...s, outputs: { ...s.outputs, scene: { node: 'scene', socket: 'out' } } };
  return s;
}

function withCamera(s: DagState, id: string, type = 'PerspectiveCamera'): DagState {
  return applyOp(s, {
    type: 'addNode',
    nodeId: id,
    nodeType: type,
    params: { fov: 28, position: [7, 1, -4], lookAt: [0, 0, 0] },
  }).next;
}

describe('#479 — stripDriveRefusal (a strip must not be offered where it cannot drive)', () => {
  it('a mesh is drivable → null', () => {
    expect(stripDriveRefusal(buildScene(), 'box')).toBeNull();
  });

  it('BOTH fused camera types are refused, with a reason that says why', () => {
    for (const type of ['PerspectiveCamera', 'OrthographicCamera']) {
      const s = withCamera(buildScene(), 'n_cam', type);
      const reason = stripDriveRefusal(s, 'n_cam');
      expect(reason, type).not.toBeNull();
      expect(reason, type).toMatch(/camera/i);
      // It must state the CONSEQUENCE, not just the verdict — this string is the
      // disabled button's whole explanation to the director.
      expect(reason, type).toMatch(/delete/i);
    }
  });

  // The caller owns "does this node exist" — answering it here too would put two
  // different messages on one failure (dispatchPushDownToStrip already refuses first).
  it('an unknown id is NOT this predicate’s refusal → null', () => {
    expect(stripDriveRefusal(buildScene(), 'nope')).toBeNull();
  });
});

describe('#479 — the picker consumes the same predicate', () => {
  // ⚠️ FIXTURE CHOICE IS LOAD-BEARING. A TOP-LEVEL camera is wired into `scene.camera`,
  // so its row carries `parent.socket:'camera'` and the socket filter excludes it on its
  // own — such a fixture passes even with the drive check deleted, measuring the wrong
  // thing. A camera nested in a GROUP carries the Group's socket instead, so the drive
  // check is the only thing excluding it. That is also the case #387 makes fragile: post
  // split the row's `nodeType` is 'Object', and a type-keyed filter would fail open here.
  it('excludes a camera NESTED IN A GROUP — the case the socket filter does not cover', () => {
    let s = buildScene();
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'grp',
      nodeType: 'Group',
      params: { name: 'Rig', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'grp', socket: 'out' },
      to: { node: 'scene', socket: 'children' },
    }).next;
    s = withCamera(s, 'n_cam');
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_cam', socket: 'out' },
      to: { node: 'grp', socket: 'children' },
    }).next;

    const ids = stripTargetRows(s).map((r) => r.id);
    // The positive control: the group and the box ARE offered, so an empty result
    // cannot pass for a working exclusion.
    expect(ids).toContain('box');
    expect(ids).toContain('grp');
    expect(ids).not.toContain('n_cam');
  });
});

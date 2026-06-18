// resolveWorldTransform — the pure WORLD-transform composition (epic #201, slice
// #202). These assert the resolver MIRRORS the SceneFromDAG accumulation: a node
// nested under a Transform/Group resolves to ancestorWorld · ownLocal, the exact
// product three.js computes from the nested <group>/<mesh> tree. The e2e
// boundary-pair (tests/e2e/p202-world-transform-boundary-pair.spec.ts) proves the
// same value against the REAL rendered object; this suite proves the math.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.3; vyapti V37/V58.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveWorldTransform } from './resolveWorldTransform';

const BOX_ID = 'n_box';
const XF_ID = 'n_xf';
const GRP_ID = 'n_grp';

function ctxAt(seconds: number) {
  return { time: { frame: Math.round(seconds * 60), seconds, normalized: 0 } };
}

/**
 * Insert a Transform between n_box and the scene so the box is NESTED:
 *   scene.children → Transform(target = box).
 * The Transform carries a position/rotation/scale offset; the box keeps its own
 * local TRS. The box's WORLD transform must be Transform.local · box.local.
 */
function buildNestedTransformState(opts: {
  xfPos?: [number, number, number];
  xfRot?: [number, number, number];
  xfScale?: [number, number, number];
  boxPos?: [number, number, number];
}): DagState {
  let state = buildDefaultDagState();
  // Pin the box's local pose.
  state = applyOp(state, {
    type: 'setParam',
    nodeId: BOX_ID,
    paramPath: 'position',
    value: opts.boxPos ?? [0, 0, 0],
  }).next;

  const ops: Op[] = [
    {
      type: 'addNode',
      nodeId: XF_ID,
      nodeType: 'Transform',
      params: {
        name: 'xf',
        position: opts.xfPos ?? [0, 0, 0],
        rotation: opts.xfRot ?? [0, 0, 0],
        scale: opts.xfScale ?? [1, 1, 1],
      },
    },
    // Re-parent: box was wired straight to scene.children; route it through the
    // Transform instead. (disconnect box→scene, connect box→xf, connect xf→scene)
    {
      type: 'disconnect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
    { type: 'connect', from: { node: BOX_ID, socket: 'out' }, to: { node: XF_ID, socket: 'target' } },
    {
      type: 'connect',
      from: { node: XF_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

describe('resolveWorldTransform', () => {
  // 1. TOP-LEVEL node: world == local (the SceneChildNode wrapper is identity).
  it('a top-level box resolves world == its local position', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [2, 3, 4],
    }).next;
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(2, 6);
    expect(w!.position[1]).toBeCloseTo(3, 6);
    expect(w!.position[2]).toBeCloseTo(4, 6);
  });

  // 2. NESTED under a translating Transform: world = xf.pos + box.local.
  it('composes a nested box world position through a parent Transform translation', () => {
    const state = buildNestedTransformState({ xfPos: [10, 0, 0], boxPos: [1, 2, 3] });
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(11, 6); // 10 + 1
    expect(w!.position[1]).toBeCloseTo(2, 6);
    expect(w!.position[2]).toBeCloseTo(3, 6);
  });

  // 3. Parent ROTATION composes (the case a translation-only walk would miss):
  //    a 90° parent yaw maps the box's local +X onto world -Z (three.js 'XYZ').
  it('composes a parent 90° Y rotation onto the child local offset', () => {
    const state = buildNestedTransformState({ xfRot: [0, 90, 0], boxPos: [1, 0, 0] });
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    // R_y(90°) · (1,0,0) = (0,0,-1)
    expect(w!.position[0]).toBeCloseTo(0, 5);
    expect(w!.position[1]).toBeCloseTo(0, 5);
    expect(w!.position[2]).toBeCloseTo(-1, 5);
  });

  // 4. Parent SCALE multiplies the child offset; the child's world scale is the
  //    parent scale (the box's own scale is identity here).
  it('composes a parent scale onto the child offset and scale', () => {
    const state = buildNestedTransformState({ xfScale: [2, 2, 2], boxPos: [1, 1, 1] });
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(2, 6);
    expect(w!.position[1]).toBeCloseTo(2, 6);
    expect(w!.position[2]).toBeCloseTo(2, 6);
    expect(w!.scale[0]).toBeCloseTo(2, 6);
  });

  // 5. The Transform NODE itself resolves to its own world (descent returns at it).
  it('resolves the Transform node itself to its own world transform', () => {
    const state = buildNestedTransformState({ xfPos: [5, 6, 7] });
    const w = resolveWorldTransform(state, XF_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(5, 6);
    expect(w!.position[1]).toBeCloseTo(6, 6);
    expect(w!.position[2]).toBeCloseTo(7, 6);
  });

  // 6. ANIMATED ancestor: a free-floating channel on the Transform moves the
  //    child's WORLD position in lockstep at distinct playhead times (V57/H40 —
  //    the same overlay the renderer applies). ≥2 times, mirrors the e2e gate.
  it('tracks an animated parent Transform: child world follows the playhead', () => {
    let state = buildNestedTransformState({ boxPos: [1, 0, 0] });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_xf_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'xfpos',
        target: XF_ID,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [10, 0, 0], easing: 'linear' },
        ],
      },
    }).next;
    const at0 = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    const at1 = resolveWorldTransform(state, BOX_ID, ctxAt(1));
    expect(at0!.position[0]).toBeCloseTo(1, 6); // 0 + box.local 1
    expect(at1!.position[0]).toBeCloseTo(11, 6); // 10 + box.local 1
    expect(at0!.position[0]).not.toBeCloseTo(at1!.position[0], 6);
  });

  // 7. NESTED under a Group (identity) AND a Transform: Group contributes nothing,
  //    Transform contributes its TRS — the §202 "Transform/Group hierarchy" shape.
  it('descends a Group (identity) wrapping a Transform → box world', () => {
    // scene → Group → Transform → box
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [1, 0, 0],
    }).next;
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: XF_ID,
        nodeType: 'Transform',
        params: { name: 'xf', position: [0, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      { type: 'addNode', nodeId: GRP_ID, nodeType: 'Group', params: { name: 'grp' } },
      {
        type: 'disconnect',
        from: { node: BOX_ID, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: BOX_ID, socket: 'out' },
        to: { node: XF_ID, socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: XF_ID, socket: 'out' },
        to: { node: GRP_ID, socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: GRP_ID, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(1, 6);
    expect(w!.position[1]).toBeCloseTo(5, 6); // from the Transform
    expect(w!.position[2]).toBeCloseTo(0, 6);
  });

  // 8. IDENTITY-NULL: unknown id, and a node that is not a scene-child descendant.
  it('returns null for an unknown id and a non-scene-child node (no crash)', () => {
    const state = buildNestedTransformState({});
    expect(resolveWorldTransform(state, 'not_a_node', ctxAt(0))).toBeNull();
    // n_camera is a real node but wired to scene.camera, not scene.children.
    expect(resolveWorldTransform(state, 'n_camera', ctxAt(0))).toBeNull();
  });
});

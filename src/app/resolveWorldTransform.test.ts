// resolveWorldTransform — the pure WORLD-transform composition (epic #201, slice
// #202). These assert the resolver MIRRORS the SceneFromDAG accumulation: a node
// nested under a Transform/Group resolves to ancestorWorld · ownLocal, the exact
// product three.js computes from the nested <group>/<mesh> tree. The e2e
// boundary-pair (tests/e2e/p202-world-transform-boundary-pair.spec.ts) proves the
// same value against the REAL rendered object; this suite proves the math.
//
// REF: epic #201, docs/OPERATORS-AND-LIGHTING-DESIGN.md §4.3; vyapti V37/V58.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { __resetRegistryForTests } from '../core/dag';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { resolveParentWorldMatrix, resolveWorldTransform } from './resolveWorldTransform';

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
    {
      type: 'connect',
      from: { node: BOX_ID, socket: 'out' },
      to: { node: XF_ID, socket: 'target' },
    },
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

  // 7b. MaterialOverride is a pass-through (identity, no wrapper group): a box
  //     nested under a translating Transform AND a MaterialOverride still composes
  //     through to Transform.local · box.local — the override contributes nothing
  //     to the world matrix. Locks the documented childEdges MaterialOverride path.
  it('descends a MaterialOverride (identity pass-through) without altering world', () => {
    // scene → Transform → MaterialOverride → box
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [1, 0, 0],
    }).next;
    const MO_ID = 'n_mo';
    const ops: Op[] = [
      {
        type: 'addNode',
        nodeId: XF_ID,
        nodeType: 'Transform',
        params: { name: 'xf', position: [0, 4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        type: 'addNode',
        nodeId: MO_ID,
        nodeType: 'MaterialOverride',
        params: { name: 'mo' },
      },
      {
        type: 'disconnect',
        from: { node: BOX_ID, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
      {
        type: 'connect',
        from: { node: BOX_ID, socket: 'out' },
        to: { node: MO_ID, socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: MO_ID, socket: 'out' },
        to: { node: XF_ID, socket: 'target' },
      },
      {
        type: 'connect',
        from: { node: XF_ID, socket: 'out' },
        to: { node: 'n_scene', socket: 'children' },
      },
    ];
    for (const op of ops) state = applyOp(state, op).next;
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(1, 6);
    expect(w!.position[1]).toBeCloseTo(4, 6); // Transform only; MaterialOverride adds nothing
    expect(w!.position[2]).toBeCloseTo(0, 6);
  });

  // 8. LIGHTS (#210) — a light is flat in scene.lights, so its world == its own
  //    overlaid local transform. The resolver is now uniform across node kinds.
  const LIGHT_ID = 'n_area_light';
  function buildAreaLightState(opts: {
    pos?: [number, number, number];
    rot?: [number, number, number];
    scale?: [number, number, number];
  }): DagState {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: LIGHT_ID,
      nodeType: 'AreaLight',
      params: {
        intensity: 5,
        position: opts.pos ?? [0, 0, 0],
        rotation: opts.rot ?? [0, 0, 0],
        scale: opts.scale ?? [1, 1, 1],
        color: '#ffffff',
        width: 2,
        height: 2,
        lookAt: [0, 0, 0],
      },
    }).next;
    state = applyOp(state, {
      type: 'connect',
      from: { node: LIGHT_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'lights' },
    }).next;
    return state;
  }

  it('a flat AreaLight resolves world == its own position/scale (uniform with meshes)', () => {
    const state = buildAreaLightState({ pos: [3, 4, 5], scale: [2, 2, 2] });
    const w = resolveWorldTransform(state, LIGHT_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(3, 6);
    expect(w!.position[1]).toBeCloseTo(4, 6);
    expect(w!.position[2]).toBeCloseTo(5, 6);
    expect(w!.scale[0]).toBeCloseTo(2, 6);
  });

  it('tracks an animated light: world position follows the playhead', () => {
    let state = buildAreaLightState({ pos: [0, 0, 0] });
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_light_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'lightpos',
        target: LIGHT_ID,
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [10, 0, 0], easing: 'linear' },
        ],
      },
    }).next;
    const at0 = resolveWorldTransform(state, LIGHT_ID, ctxAt(0));
    const at1 = resolveWorldTransform(state, LIGHT_ID, ctxAt(1));
    expect(at0!.position[0]).toBeCloseTo(0, 6);
    expect(at1!.position[0]).toBeCloseTo(10, 6);
    expect(at0!.position[0]).not.toBeCloseTo(at1!.position[0], 6);
  });

  // 9. CAMERAS (#210 slice 3.2) — a camera resolves via its pose (position +
  //    look-orientation), uniform with meshes/lights even though it is wired via
  //    scene.camera, not scene.children.
  it('resolves a camera world from its pose (position matches the node params)', () => {
    const state = buildDefaultDagState();
    const camPos = (state.nodes['n_camera'].params as { position: [number, number, number] })
      .position;
    const w = resolveWorldTransform(state, 'n_camera', ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(camPos[0], 6);
    expect(w!.position[1]).toBeCloseTo(camPos[1], 6);
    expect(w!.position[2]).toBeCloseTo(camPos[2], 6);
  });

  it('tracks an animated camera: world position follows the playhead', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'addNode',
      nodeId: 'n_cam_pos_ch',
      nodeType: 'KeyframeChannelVec3',
      params: {
        name: 'campos',
        target: 'n_camera',
        paramPath: 'position',
        keyframes: [
          { time: 0, value: [0, 0, 0], easing: 'linear' },
          { time: 1, value: [10, 0, 0], easing: 'linear' },
        ],
      },
    }).next;
    const at0 = resolveWorldTransform(state, 'n_camera', ctxAt(0));
    const at1 = resolveWorldTransform(state, 'n_camera', ctxAt(1));
    expect(at0!.position[0]).toBeCloseTo(0, 6);
    expect(at1!.position[0]).toBeCloseTo(10, 6);
    expect(at0!.position[0]).not.toBeCloseTo(at1!.position[0], 6);
  });

  // 10. IDENTITY-NULL: unknown id (no crash).
  it('returns null for an unknown id (no crash)', () => {
    const state = buildNestedTransformState({});
    expect(resolveWorldTransform(state, 'not_a_node', ctxAt(0))).toBeNull();
  });
});

// resolveParentWorldMatrix (#230) — the PARENT world matrix the gizmo anchors to.
// null for top-level / flat / unresolvable (gizmo keeps the local path); the
// ancestor world for a genuinely nested child. Pairs with the gizmo e2e
// (tests/e2e/p230-nested-gizmo-world.spec.ts) which proves the same against the
// REAL rendered object + the world→local write-back.
describe('resolveParentWorldMatrix', () => {
  // NESTED → the parent's world matrix (the Transform's translation).
  it('returns the parent world matrix for a nested box (translation)', () => {
    const state = buildNestedTransformState({ xfPos: [10, 0, 0], boxPos: [1, 2, 3] });
    const m = resolveParentWorldMatrix(state, BOX_ID, ctxAt(0));
    expect(m).not.toBeNull();
    // Column-major translation lives in elements 12,13,14.
    expect(m!.elements[12]).toBeCloseTo(10, 6);
    expect(m!.elements[13]).toBeCloseTo(0, 6);
    expect(m!.elements[14]).toBeCloseTo(0, 6);
    // parentWorld · box.local == resolveWorldTransform(box): 10 + 1 = 11.
    const w = resolveWorldTransform(state, BOX_ID, ctxAt(0));
    expect(w!.position[0]).toBeCloseTo(11, 6);
  });

  // The parent must compose ROTATION too (a translation-only inverse would be wrong
  // for the gizmo's world→local conversion under a rotated parent).
  it('returns a rotated parent world matrix (90° Y)', () => {
    const state = buildNestedTransformState({ xfRot: [0, 90, 0], boxPos: [1, 0, 0] });
    const m = resolveParentWorldMatrix(state, BOX_ID, ctxAt(0));
    expect(m).not.toBeNull();
    // R_y(90°)·(1,0,0) applied via the parent maps the local +X to world -Z.
    const v = new THREE.Vector3(1, 0, 0).applyMatrix4(m!);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.z).toBeCloseTo(-1, 5);
  });

  // TOP-LEVEL box → null (parent is the identity scene root; gizmo stays local).
  it('returns null for a top-level box (identity parent)', () => {
    let state = buildDefaultDagState();
    state = applyOp(state, {
      type: 'setParam',
      nodeId: BOX_ID,
      paramPath: 'position',
      value: [2, 3, 4],
    }).next;
    expect(resolveParentWorldMatrix(state, BOX_ID, ctxAt(0))).toBeNull();
  });

  // A nested child under an IDENTITY parent (Transform at origin) → null too
  // (parent composes to identity → world == local → gizmo correctly stays local).
  it('returns null when the parent composes to identity', () => {
    const state = buildNestedTransformState({ xfPos: [0, 0, 0], boxPos: [1, 2, 3] });
    expect(resolveParentWorldMatrix(state, BOX_ID, ctxAt(0))).toBeNull();
  });

  // FLAT light + camera → null (never nested; gizmo edits their own local params).
  it('returns null for a flat light and a camera', () => {
    const state = buildDefaultDagState();
    expect(resolveParentWorldMatrix(state, 'n_camera', ctxAt(0))).toBeNull();
  });

  // Unknown id → null (no crash).
  it('returns null for an unknown id', () => {
    const state = buildNestedTransformState({ xfPos: [10, 0, 0] });
    expect(resolveParentWorldMatrix(state, 'not_a_node', ctxAt(0))).toBeNull();
  });
});

// #231 Inc 2a — a LIGHT nested in a Group. The unified socket (Inc 1) lets a
// light wire into Group.children; the world resolver's scene-child walk already
// descends Group children and localMatrix handles a light's position/rotation/
// scale, so a nested light's WORLD composes the group's transform — and the
// gizmo (#230) gets the group as the light's parent world. NO resolver change
// was needed; these prove the nested light flows through the existing walk.
const LIT_ID = 'n_grouped_light';
const LGRP_ID = 'n_light_group';

/** scene.children → Group(pos) → children:[DirectionalLight(localPos)]. */
function buildGroupedLightState(
  groupPos: [number, number, number],
  lightPos: [number, number, number],
): DagState {
  let state = buildDefaultDagState();
  const ops: Op[] = [
    { type: 'addNode', nodeId: LGRP_ID, nodeType: 'Group', params: { position: groupPos } },
    {
      type: 'addNode',
      nodeId: LIT_ID,
      nodeType: 'DirectionalLight',
      params: { intensity: 1, position: lightPos, color: '#ffffff' },
    },
    {
      type: 'connect',
      from: { node: LIT_ID, socket: 'out' },
      to: { node: LGRP_ID, socket: 'children' },
    },
    {
      type: 'connect',
      from: { node: LGRP_ID, socket: 'out' },
      to: { node: 'n_scene', socket: 'children' },
    },
  ];
  for (const op of ops) state = applyOp(state, op).next;
  return state;
}

describe('resolveWorldTransform — #231 Inc 2a grouped light', () => {
  beforeEach(() => {
    __resetRegistryForTests();
    __reseedAllNodesForTests();
  });

  it("composes a nested light's world position through its parent Group translation", () => {
    const state = buildGroupedLightState([5, 0, 0], [1, 0, 0]);
    const w = resolveWorldTransform(state, LIT_ID, ctxAt(0));
    expect(w).not.toBeNull();
    expect(w!.position[0]).toBeCloseTo(6, 6); // 5 (group) + 1 (light local)
    expect(w!.position[1]).toBeCloseTo(0, 6);
    expect(w!.position[2]).toBeCloseTo(0, 6);
  });

  it('gives the gizmo the Group as the nested light parent world (not null)', () => {
    const state = buildGroupedLightState([5, 0, 0], [1, 0, 0]);
    const parent = resolveParentWorldMatrix(state, LIT_ID, ctxAt(0));
    expect(parent).not.toBeNull();
    // The parent world is the Group's translation: its 4th column is [5,0,0].
    expect(parent!.elements[12]).toBeCloseTo(5, 6);
  });
});

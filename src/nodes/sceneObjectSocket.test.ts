// #231 Inc 1 — unified 'SceneObject' socket. The DELIVERABLE of this increment
// is that the type system now ALLOWS a light or a camera into a `children`
// socket (Scene/Group), which Blender's "everything is an Object" model needs
// and which Inc 2 (groupable/parentable lights & cameras) builds on. Before
// #231 these threw `connect: type mismatch …:Light → …:Mesh`.
//
// These assertions are FALSIFIABLE: revert any scene-object node's output (or a
// `children` socket) back to 'Mesh'/'Light'/'Camera' and the corresponding case
// flips. The last case proves we did NOT disable type checking — a scene object
// (now 'SceneObject') is still rejected by the strictly-typed `lightRig`
// ('LightRig') socket.

import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, emptyDagState, __resetRegistryForTests } from '../core/dag';
import { OpError } from '../core/dag/ops';
import { __reseedAllNodesForTests } from './registerAll';
import type { DagState } from '../core/dag/state';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

const PARAMS: Record<string, Record<string, unknown>> = {
  BoxMesh: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  DirectionalLight: { intensity: 1, position: [0, 0, 0], color: '#ffffff' },
  PointLight: { intensity: 1, position: [0, 0, 0], color: '#ffffff', distance: 0, decay: 2 },
  PerspectiveCamera: { fov: 45, near: 0.01, far: 1000, position: [0, 0, 5], lookAt: [0, 0, 0] },
  Group: {},
  Scene: {},
};

function withNode(state: DagState, nodeId: string, nodeType: string): DagState {
  return applyOp(state, { type: 'addNode', nodeId, nodeType, params: PARAMS[nodeType] ?? {} }).next;
}

describe('#231 Inc 1 — unified SceneObject socket', () => {
  it('a light connects into Group.children (was a type mismatch before #231)', () => {
    let state = emptyDagState();
    state = withNode(state, 'lt', 'DirectionalLight');
    state = withNode(state, 'grp', 'Group');
    const { next } = applyOp(state, {
      type: 'connect',
      from: { node: 'lt', socket: 'out' },
      to: { node: 'grp', socket: 'children' },
    });
    expect(next.nodes.grp.inputs.children).toEqual([{ node: 'lt', socket: 'out' }]);
  });

  it('a camera connects into Scene.children', () => {
    let state = emptyDagState();
    state = withNode(state, 'cam', 'PerspectiveCamera');
    state = withNode(state, 'scn', 'Scene');
    const { next } = applyOp(state, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: 'scn', socket: 'children' },
    });
    expect(next.nodes.scn.inputs.children).toEqual([{ node: 'cam', socket: 'out' }]);
  });

  it('a mesh still connects into Scene.children (regression — the original capability)', () => {
    let state = emptyDagState();
    state = withNode(state, 'bx', 'BoxMesh');
    state = withNode(state, 'scn', 'Scene');
    const { next } = applyOp(state, {
      type: 'connect',
      from: { node: 'bx', socket: 'out' },
      to: { node: 'scn', socket: 'children' },
    });
    expect(next.nodes.scn.inputs.children).toEqual([{ node: 'bx', socket: 'out' }]);
  });

  it('a light still connects into Scene.lights (the existing top-level band is unbroken)', () => {
    let state = emptyDagState();
    state = withNode(state, 'lt', 'PointLight');
    state = withNode(state, 'scn', 'Scene');
    const { next } = applyOp(state, {
      type: 'connect',
      from: { node: 'lt', socket: 'out' },
      to: { node: 'scn', socket: 'lights' },
    });
    expect(next.nodes.scn.inputs.lights).toEqual([{ node: 'lt', socket: 'out' }]);
  });

  it('a SceneObject is STILL rejected by the strictly-typed lightRig socket — validation is not disabled', () => {
    let state = emptyDagState();
    state = withNode(state, 'bx', 'BoxMesh');
    state = withNode(state, 'scn', 'Scene');
    expect(() =>
      applyOp(state, {
        type: 'connect',
        from: { node: 'bx', socket: 'out' },
        to: { node: 'scn', socket: 'lightRig' },
      }),
    ).toThrow(OpError);
  });
});

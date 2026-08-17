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
import { registerAllNodes } from './registerAll';
import type { DagState } from '../core/dag/state';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

// The node types below are deliberately DIFFERENT types, because that is the whole claim:
// heterogeneous scene objects all emit 'SceneObject' and all fit one socket. The fused posable
// lights, the fused BoxMesh and the fused PerspectiveCamera used to play the light, the mesh
// and the camera here; all were retired by the object↔data split (#365 Phase 5 / #599) and a
// posed mesh, light or camera is now an `Object`. `AmbientLight` keeps the LIGHT case on a
// genuinely distinct node type — ambient is a World datablock and was never split, so it is
// the one light that is still its own type rather than an Object.
//
// That leaves TWO distinct types, not three, and the shrinkage is honest: the socket really is
// unified, so there are fewer distinct producers left to prove it with. Adding a third type
// back for symmetry would be asserting about the fixture, not the product.
const PARAMS: Record<string, Record<string, unknown>> = {
  Object: {},
  AmbientLight: { intensity: 1, color: '#ffffff' },
  Group: {},
  Scene: {},
};

function withNode(state: DagState, nodeId: string, nodeType: string): DagState {
  return applyOp(state, { type: 'addNode', nodeId, nodeType, params: PARAMS[nodeType] ?? {} }).next;
}

describe('#231 Inc 1 — unified SceneObject socket', () => {
  it('a light connects into Group.children (was a type mismatch before #231)', () => {
    let state = emptyDagState();
    state = withNode(state, 'lt', 'AmbientLight');
    state = withNode(state, 'grp', 'Group');
    const { next } = applyOp(state, {
      type: 'connect',
      from: { node: 'lt', socket: 'out' },
      to: { node: 'grp', socket: 'children' },
    });
    expect(next.nodes.grp.inputs.children).toEqual([{ node: 'lt', socket: 'out' }]);
  });

  // The CAMERA case stood here on the fused `PerspectiveCamera` until #599 deleted it. It is
  // not retargeted, because a posed camera is now an `Object` — the very node the mesh case
  // below already uses, so the retarget would produce a byte-identical duplicate that reads
  // like coverage and adds none. The heterogeneity this describe block asserts is carried by
  // the two node types that are still genuinely distinct: `AmbientLight` and `Object`.

  it('a mesh still connects into Scene.children (regression — the original capability)', () => {
    let state = emptyDagState();
    state = withNode(state, 'bx', 'Object');
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
    state = withNode(state, 'lt', 'AmbientLight');
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
    state = withNode(state, 'bx', 'Object');
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

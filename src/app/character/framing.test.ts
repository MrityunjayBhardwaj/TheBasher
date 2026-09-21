// #856 — WHICH NODES "FRAME SELECTED" CAN ACTUALLY FRAME.
//
// The report is "Frame Selected does nothing on my imported character", and
// until now the only ways to answer it were reading `anchorForNode` or noticing
// that the camera had not moved. That set was unstated and untested, on a
// function three affordances call (the View menu, the F key, and the viewport's
// Home button).
//
// 🔑 AND IT SETTLES THE ISSUE'S STATED CAUSE, WHICH HAS MOVED. #856 says "the
// import mints a Group whose anchor is null, so there is nothing for it to
// frame". Measured below: a `Group` carries its own `position` — the import
// bakes position = pivot = the model centre so the content stays put while the
// gizmo sits somewhere sensible — so it DOES anchor. Whatever silence the
// director hit, this is not it, and the next person should not spend the
// afternoon adding an anchor that is already there.
//
// What was really wrong is one layer out and is fixed alongside this file: the
// Home button guarded on `primaryNodeId !== null` instead of on what
// frameSelected actually did, so a selection that could not be framed reached
// neither Frame Selected nor the Frame All fallback.
//
// REF: src/app/character/framing.ts (`anchorForNode`, `frameSelected`);
//      src/app/FloatingViewportToolbar.tsx (`homeFrame`, the fallback);
//      src/nodes/Group.ts (position = pivot = the model centre); issue #856.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState } from '../../core/dag';
import { useDagStore } from '../../core/dag/store';
import { registerAllNodes } from '../../nodes/registerAll';
import * as THREE from 'three';
import { anchorForNode, applyFit, boundsForNode, frameSelected } from './framing';
import { useSelectionStore } from '../stores/selectionStore';
import { useThreeRef } from './threeRef';
import type { DagState } from '../../core/dag/state';

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

function stateWith(nodes: Array<{ id: string; type: string; params?: unknown }>): DagState {
  let s = emptyDagState();
  for (const n of nodes) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: n.id,
      nodeType: n.type,
      params: (n.params ?? {}) as never,
    }).next;
  }
  return s;
}

describe('#856 — anchorForNode: the set of framable nodes, stated', () => {
  it('anchors anything carrying its own position, the import Group INCLUDED', () => {
    const state = stateWith([
      { id: 'xf', type: 'Transform', params: { position: [1, 2, 3] } },
      // The shape an import mints. Its position is the model centre, which is
      // exactly the point a director means by "frame this character".
      { id: 'grp', type: 'Group', params: { position: [4, 5, 6] } },
    ]);
    useDagStore.setState({ state });

    expect(anchorForNode('xf')?.toArray()).toEqual([1, 2, 3]);
    expect(
      anchorForNode('grp')?.toArray(),
      'a Group anchors — #856 says the import Group has no anchor, and it does',
    ).toEqual([4, 5, 6]);
  });

  it('answers null for a node with no position and for one that is not there', () => {
    // The honest half. `null` is the function saying it cannot, and the callers
    // must treat that as a REPORT rather than as nothing having happened —
    // which is the defect this issue is really about.
    const state = stateWith([{ id: 'clip', type: 'AnimationClip', params: { name: 'walk' } }]);
    useDagStore.setState({ state });

    expect(anchorForNode('clip'), 'a clip has no place in the world').toBeNull();
    expect(anchorForNode('nope'), 'a node id that is not in the graph').toBeNull();
  });

  it('does not mistake a malformed position for one it can use', () => {
    // Params reach this from stored JSON, where the type is a promise rather
    // than a guarantee. A two-element array read as a Vector3 would frame the
    // camera at a coordinate nobody authored, which is worse than not framing.
    const state = stateWith([{ id: 'xf', type: 'Transform', params: { position: [1, 2, 3] } }]);
    const broken: DagState = {
      ...state,
      nodes: {
        ...state.nodes,
        xf: { ...state.nodes.xf, params: { position: [1, 2] } },
      },
    };
    useDagStore.setState({ state: broken });
    expect(anchorForNode('xf')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #969 — FRAMING FITS THE SUBJECT, IT DOES NOT ONLY RE-CENTRE ON IT
// ─────────────────────────────────────────────────────────────────────────
//
// The report is "I imported a character and it is inside the cube, and Frame
// Selected does not rescue it". Measured in the running app before this change:
// F on the import's Group moved the camera from [1.88, 1.25, 1.88] to
// [1.88, 1.74, 1.92] — it re-centred on the model centre and kept its distance,
// so a character that did not fit before still did not fit.
//
// `applyTarget` preserves the offset ON PURPOSE (it is the follow's math too),
// so the fit is a separate function beside it rather than a change to it.
//
// GROUNDED in the reference: Blender's View Selected re-centres AND dollies.
// Observed in 4.5.9, view parked at distance 50 on the default 2 m cube:
// `view_distance` 50 → 3.279, `view_location` → (0,0,0), rotation untouched.
describe('#969 — the framing gesture fits what the subject actually is', () => {
  /** A scene holding ONE box of half-extent `h` at the origin, named for a node. */
  function sceneWithBox(nodeId: string, h: number): THREE.Scene {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(h * 2, h * 2, h * 2));
    mesh.name = nodeId;
    scene.add(mesh);
    return scene;
  }

  function cameraAt(pos: [number, number, number], target: THREE.Vector3): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 500);
    cam.position.set(...pos);
    useThreeRef.setState({ camera: cam, controlsTarget: target });
    return cam;
  }

  it('reads the bounds of what a node DRAWS, and reports null when it draws nothing', () => {
    useThreeRef.setState({ scene: sceneWithBox('n_box', 1) });
    const b = boundsForNode('n_box');
    expect(b, 'a mounted mesh has measurable bounds').not.toBeNull();
    expect(b!.radius).toBeGreaterThan(0.9);
    expect(boundsForNode('n_absent'), 'a node with no object in the scene').toBeNull();
  });

  it('DOLLIES to the subject — the distance is a function of its size, not of where the camera was', () => {
    // The falsification the old behaviour passes: park the camera far away and
    // frame. Re-centring alone leaves the distance at 50; fitting must bring it
    // to something proportional to the box.
    const target = new THREE.Vector3(0, 0, 0);
    const cam = cameraAt([50, 0, 0], target);
    useThreeRef.setState({ scene: sceneWithBox('n_box', 1) });

    expect(applyFit(boundsForNode('n_box')!)).toBe(true);
    const near = cam.position.distanceTo(target);
    expect(
      near,
      `parked at 50, framing a 1 m sphere left the camera ${near.toFixed(2)} away`,
    ).toBeLessThan(10);

    // And it SCALES: a subject ten times bigger is framed ten times further out.
    // Without this row a hard-coded distance would pass the one above.
    useThreeRef.setState({ scene: sceneWithBox('n_box', 10) });
    expect(applyFit(boundsForNode('n_box')!)).toBe(true);
    const far = cam.position.distanceTo(target);
    expect(far / near).toBeCloseTo(10, 1);
  });

  it('keeps the viewing ANGLE the director chose — only the pivot and the distance move', () => {
    // Blender preserves the view rotation; so do we. A gesture that also
    // re-orients would throw away an orbit the director set up deliberately.
    const target = new THREE.Vector3(0, 0, 0);
    const cam = cameraAt([0, 0, 30], target);
    useThreeRef.setState({ scene: sceneWithBox('n_box', 1) });
    const before = cam.position.clone().sub(target).normalize();

    applyFit(boundsForNode('n_box')!);
    const after = cam.position.clone().sub(target).normalize();
    expect(after.angleTo(before)).toBeLessThan(1e-6);
  });

  it('frameSelected FITS a node that draws, and still re-centres one that does not', () => {
    const state = stateWith([
      { id: 'n_box', type: 'Group', params: { position: [0, 0, 0] } },
      { id: 'lamp', type: 'Transform', params: { position: [4, 0, 0] } },
    ]);
    useDagStore.setState({ state });

    const target = new THREE.Vector3(0, 0, 0);
    const cam = cameraAt([40, 0, 0], target);
    useThreeRef.setState({ scene: sceneWithBox('n_box', 1) });

    useSelectionStore.setState({ primaryNodeId: 'n_box' } as never);
    expect(frameSelected()).toBe(true);
    expect(cam.position.distanceTo(target), 'the drawn node is fitted').toBeLessThan(10);

    // A node with no object in the scene keeps the ANCHOR road: re-centre at the
    // distance the camera already had, which is all there is to do with no size.
    useSelectionStore.setState({ primaryNodeId: 'lamp' } as never);
    const distBefore = cam.position.distanceTo(target);
    expect(frameSelected()).toBe(true);
    expect(target.toArray(), 'the pivot moved to the anchor').toEqual([4, 0, 0]);
    expect(cam.position.distanceTo(target)).toBeCloseTo(distBefore, 6);
  });

  it('an ORTHOGRAPHIC view is framed by zoom, which position alone would not do', () => {
    // An ortho frustum's extent is `zoom`; moving it re-centres and leaves the
    // subject exactly the same size on screen.
    const target = new THREE.Vector3(0, 0, 0);
    const cam = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.01, 500);
    cam.position.set(30, 0, 0);
    cam.zoom = 1;
    useThreeRef.setState({
      camera: cam,
      controlsTarget: target,
      scene: sceneWithBox('n_box', 1),
      gl: { domElement: { clientHeight: 1080 } } as unknown as THREE.WebGLRenderer,
    });

    expect(applyFit(boundsForNode('n_box')!)).toBe(true);
    expect(cam.zoom, 'the ortho view zoomed to the subject').toBeGreaterThan(1);
  });
});

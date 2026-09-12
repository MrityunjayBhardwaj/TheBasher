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
import { anchorForNode } from './framing';
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

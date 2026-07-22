// history seam — a genuine undo/redo move DROPS every position-addressed
// sub-selection (curve control point, timeline keyframe), because a history
// restore bypasses the edit commands that would re-index it (#326). A no-op
// move (empty stack) leaves the sub-selection alone.

import { beforeEach, describe, expect, it } from 'vitest';
import { useDagStore } from '../core/dag/store';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { historyRedo, historyUndo } from './history';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

/** Seed both sub-selection stores with a live-looking reference. */
function selectSubElements(): void {
  useCurveSelectionStore.getState().selectPoint('n_curve', 2);
  useTimelineSelection.getState().setActiveKeyframe({ channelId: 'n_chan', time: 1 });
}

function subSelectionsCleared(): boolean {
  return (
    useCurveSelectionStore.getState().pointIndex === null &&
    useTimelineSelection.getState().activeKeyframeId === null
  );
}

/** Two unwired nodes via hydrate (bypasses op validation), so a `removeNode`
 *  gives us one clean undoable move without wrestling a mesh param schema. */
function seedTwoNodes(): void {
  useDagStore.getState().hydrate({
    nodes: {
      n_a: { id: 'n_a', type: 'BoxMesh', version: 1, params: { size: [1, 1, 1] }, inputs: {} },
      n_b: { id: 'n_b', type: 'BoxMesh', version: 1, params: { size: [1, 1, 1] }, inputs: {} },
    },
    outputs: {},
  });
}

beforeEach(() => {
  __reseedAllNodesForTests();
  useDagStore.getState().reset();
  useCurveSelectionStore.getState().clear();
  useTimelineSelection.getState().setActiveKeyframe(null);
});

describe('history seam (#326)', () => {
  it('undo drops the position-addressed sub-selections AND performs the DAG move', () => {
    seedTwoNodes();
    useDagStore.getState().dispatch({ type: 'removeNode', nodeId: 'n_b' }); // one undo entry
    expect(useDagStore.getState().state.nodes.n_b).toBeUndefined();
    selectSubElements();

    historyUndo();

    // The move actually happened (removeNode undone → the node is back) — the seam
    // is not merely a selection-clearer bolted next to a dead undo.
    expect(useDagStore.getState().state.nodes.n_b).toBeDefined();
    // …and the drifting sub-selections were dropped.
    expect(subSelectionsCleared()).toBe(true);
  });

  it('redo drops the sub-selections AND re-applies the move', () => {
    seedTwoNodes();
    useDagStore.getState().dispatch({ type: 'removeNode', nodeId: 'n_b' });
    useDagStore.getState().undo(); // n_b restored, the removeNode parked on the redo stack
    selectSubElements();

    historyRedo();

    expect(useDagStore.getState().state.nodes.n_b).toBeUndefined();
    expect(subSelectionsCleared()).toBe(true);
  });

  it('CONTROL — a no-op undo (empty stack) leaves the sub-selection alone', () => {
    // Nothing dispatched → the undo stack is empty → no history move happens, so
    // there is nothing to drift and the selection must survive. This proves the
    // clear is scoped to real moves, not fired on every keypress.
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    selectSubElements();

    historyUndo();

    expect(useCurveSelectionStore.getState().pointIndex).toBe(2);
    expect(useTimelineSelection.getState().activeKeyframeId).toEqual({
      channelId: 'n_chan',
      time: 1,
    });
  });
});

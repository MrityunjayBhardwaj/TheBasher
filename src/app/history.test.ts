// history seam (#326) — a genuine undo/redo move DROPS the still-position-addressed
// keyframe sub-selection (`channelId, time`), because a history restore bypasses the
// edit commands that would re-index it. The curve control point selection is now
// id-addressed (#453), so it SURVIVES the restore — the id names the same physical
// point in the DAG that was put back. A no-op move (empty stack) leaves both alone.

import { beforeEach, describe, expect, it } from 'vitest';
import { useDagStore } from '../core/dag/store';
import { useCurveSelectionStore } from './stores/curveSelectionStore';
import { useTimelineSelection } from '../timeline/timelineSelection';
import { historyRedo, historyUndo } from './history';
import { __reseedAllNodesForTests } from '../nodes/registerAll';

/** Seed both sub-selection stores with a live-looking reference. */
function selectSubElements(): void {
  useCurveSelectionStore.getState().selectPoint('n_curve', 'cp2');
  useTimelineSelection.getState().setActiveKeyframe({ channelId: 'n_chan', time: 1 });
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
  it('undo KEEPS the id-addressed curve point, DROPS the time-addressed keyframe, and performs the move', () => {
    seedTwoNodes();
    useDagStore.getState().dispatch({ type: 'removeNode', nodeId: 'n_b' }); // one undo entry
    expect(useDagStore.getState().state.nodes.n_b).toBeUndefined();
    selectSubElements();

    historyUndo();

    // The move actually happened (removeNode undone → the node is back) — the seam
    // is not merely a selection-clearer bolted next to a dead undo.
    expect(useDagStore.getState().state.nodes.n_b).toBeDefined();
    // The curve point survives the restore — its id names the same point (#453/#326 fix).
    expect(useCurveSelectionStore.getState().pointId).toBe('cp2');
    // The keyframe is still position-addressed, so it is dropped rather than allowed to drift.
    expect(useTimelineSelection.getState().activeKeyframeId).toBeNull();
  });

  it('redo KEEPS the curve point, DROPS the keyframe, and re-applies the move', () => {
    seedTwoNodes();
    useDagStore.getState().dispatch({ type: 'removeNode', nodeId: 'n_b' });
    useDagStore.getState().undo(); // n_b restored, the removeNode parked on the redo stack
    selectSubElements();

    historyRedo();

    expect(useDagStore.getState().state.nodes.n_b).toBeUndefined();
    expect(useCurveSelectionStore.getState().pointId).toBe('cp2');
    expect(useTimelineSelection.getState().activeKeyframeId).toBeNull();
  });

  it('CONTROL — a no-op undo (empty stack) leaves BOTH sub-selections alone', () => {
    // Nothing dispatched → the undo stack is empty → no history move happens, so
    // there is nothing to drift and neither selection is touched. This proves the
    // clear is scoped to real moves, not fired on every keypress.
    expect(useDagStore.getState().undoStack).toHaveLength(0);
    selectSubElements();

    historyUndo();

    expect(useCurveSelectionStore.getState().pointId).toBe('cp2');
    expect(useTimelineSelection.getState().activeKeyframeId).toEqual({
      channelId: 'n_chan',
      time: 1,
    });
  });
});

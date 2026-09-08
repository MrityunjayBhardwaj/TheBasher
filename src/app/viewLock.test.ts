// Taking and releasing the view lock (#856).
//
// The rows state the one decision `toggleViewLock` makes — that a lock is taken
// against the selection ONCE and does not track it afterwards — plus the report
// a caller needs in order to leave an affordance honest.
//
// REF: src/app/viewLock.ts; src/app/boneSelection.ts; issue #856.

import { beforeEach, describe, expect, it } from 'vitest';
import { toggleViewLock } from './viewLock';
import { useBoneSelectionStore } from './stores/boneSelectionStore';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore } from './stores/viewportStore';

function selectNode(id: string | null): void {
  useSelectionStore.setState({
    primaryNodeId: id,
    selectedNodeId: id,
    selectedNodeIds: new Set(id ? [id] : []),
  });
}

describe('toggleViewLock', () => {
  beforeEach(() => {
    useViewportStore.getState().setViewLock(null);
    useBoneSelectionStore.getState().clear();
    selectNode(null);
  });

  it('reports false and takes no lock when nothing is selected', () => {
    expect(toggleViewLock()).toBe(false);
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('locks to the primary selection and reports it', () => {
    selectNode('group-1');
    expect(toggleViewLock()).toBe(true);
    expect(useViewportStore.getState().viewLock).toEqual({ nodeId: 'group-1', boneName: null });
  });

  it('carries the active bone, spelled as the live tree spells it', () => {
    selectNode('group-1');
    useBoneSelectionStore.getState().selectBone('group-1', 'mixamorigLeftLeg', ['Hips', 'LeftLeg']);
    toggleViewLock();
    expect(useViewportStore.getState().viewLock?.boneName).toBe('mixamorigLeftLeg');
  });

  it('releases without consulting the selection, and reports unlocked', () => {
    selectNode('group-1');
    toggleViewLock();
    selectNode(null);
    expect(toggleViewLock()).toBe(false);
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('ignores a bone belonging to some other node', () => {
    selectNode('group-1');
    useBoneSelectionStore.getState().selectBone('other-9', 'mixamorigHips', ['Hips']);
    toggleViewLock();
    expect(useViewportStore.getState().viewLock?.boneName).toBeNull();
  });
});

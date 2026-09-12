// Taking and releasing the view lock (#856).
//
// The rows state the one decision `toggleViewLock` makes — that a lock is taken
// against the selection ONCE and does not track it afterwards — plus the report
// a caller needs in order to leave an affordance honest.
//
// The later rows add the one decision #984 asked for: a lock is REFUSED, out
// loud, when the live scene has nothing for it to centre on.
//
// REF: src/app/viewLock.ts; src/app/boneSelection.ts; src/viewport/followScan.ts;
//      issues #856, #984.

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { canToggleViewLock, toggleViewLock } from './viewLock';
import { useBoneSelectionStore } from './stores/boneSelectionStore';
import { useSelectionStore } from './stores/selectionStore';
import { useViewportStore } from './stores/viewportStore';
import { useThreeRef } from './character/threeRef';
import { useDagStore } from '../core/dag/store';

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
    expect(toggleViewLock()).toEqual({ kind: 'refused', why: 'nothing-selected' });
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('locks to the primary selection and reports it', () => {
    selectNode('group-1');
    expect(toggleViewLock()).toEqual({ kind: 'locked' });
    expect(useViewportStore.getState().viewLock).toEqual({ nodeId: 'group-1', boneName: null });
  });

  it('carries the active bone, spelled as the live tree spells it', () => {
    selectNode('group-1');
    useBoneSelectionStore.getState().selectBone('group-1', 'mixamorigLeftLeg', ['Hips', 'LeftLeg']);
    toggleViewLock();
    expect(useViewportStore.getState().viewLock?.boneName).toBe('mixamorigLeftLeg');
  });

  it('🔴 offers itself exactly when it will act', () => {
    // The affordance and the toggle ask ONE predicate. This issue's first half
    // was a Home button guarding on a proxy for "the function will work", which
    // was true in the one case the function did nothing; a menu item cannot ask
    // by calling, so a second spelling here would be the same defect wearing a
    // different hat.
    expect(canToggleViewLock(null, null)).toBe(false); // nothing to lock to
    expect(canToggleViewLock(null, 'group-1')).toBe(true); // take
    expect(canToggleViewLock({ nodeId: 'group-1' }, null)).toBe(true); // release

    // And the toggle agrees with it, in the one case that is not obvious:
    // releasing while nothing is selected.
    selectNode('group-1');
    toggleViewLock();
    selectNode(null);
    expect(canToggleViewLock(useViewportStore.getState().viewLock, null)).toBe(true);
    expect(toggleViewLock()).toEqual({ kind: 'released' });
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('releases without consulting the selection, and reports unlocked', () => {
    selectNode('group-1');
    toggleViewLock();
    selectNode(null);
    // RELEASED, not refused. The two used to be one `false`, and only one of
    // them is something a caller should say out loud.
    expect(toggleViewLock()).toEqual({ kind: 'released' });
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('ignores a bone belonging to some other node', () => {
    selectNode('group-1');
    useBoneSelectionStore.getState().selectBone('other-9', 'mixamorigHips', ['Hips']);
    toggleViewLock();
    expect(useViewportStore.getState().viewLock?.boneName).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #984 — A LOCK ON SOMETHING UNFOLLOWABLE IS REFUSED, OUT LOUD
// ─────────────────────────────────────────────────────────────────────────
describe('toggleViewLock against the live scene', () => {
  /** A scene holding one group named `id`, containing `content`. */
  function stage(id: string, content: THREE.Object3D[]): void {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.name = id;
    for (const c of content) group.add(c);
    scene.add(group);
    useThreeRef.getState().setRenderRefs(null, scene);
    useDagStore.setState({
      state: {
        ...useDagStore.getState().state,
        nodes: { [id]: { id, type: 'Group', params: {}, inputs: {} } },
      },
    } as never);
  }

  function drawable(): THREE.Mesh {
    return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  }

  beforeEach(() => {
    useViewportStore.getState().setViewLock(null);
    useBoneSelectionStore.getState().clear();
    selectNode(null);
    useThreeRef.getState().setRenderRefs(null, null);
  });

  it('refuses a node that draws nothing the view can centre on, and takes no lock', () => {
    // A light's glyphs are editor chrome and are pruned from the bounds, so the
    // group resolves and yields no point. That lookup SUCCEEDING is the whole
    // trap: nothing is null, no guard fires, and the lock used to latch its
    // checkmark beside a view that never moved.
    stage('n_light', []);
    selectNode('n_light');
    expect(toggleViewLock()).toEqual({ kind: 'refused', why: 'nothing-to-follow' });
    expect(useViewportStore.getState().viewLock).toBeNull();
  });

  it('...and still takes a lock on a node that does draw something', () => {
    // The losing alternative, and without it the row above is satisfied by a
    // check that refuses everything.
    stage('n_box', [drawable()]);
    selectNode('n_box');
    expect(toggleViewLock()).toEqual({ kind: 'locked' });
    expect(useViewportStore.getState().viewLock).toEqual({ nodeId: 'n_box', boneName: null });
  });

  it('refuses a node that produces nothing in the scene at all', () => {
    // A data-only node can still be the primary selection. Nothing is named
    // after it, so there is not even a wrapper to measure.
    stage('n_box', [drawable()]);
    selectNode('n_datamap');
    useDagStore.setState({
      state: {
        ...useDagStore.getState().state,
        nodes: { n_datamap: { id: 'n_datamap', type: 'BoneNameMap', params: {}, inputs: {} } },
      },
    } as never);
    expect(toggleViewLock()).toEqual({ kind: 'refused', why: 'nothing-to-follow' });
  });

  it('takes the lock when it cannot tell, because "I cannot tell" is not "there is nothing"', () => {
    // No scene pushed yet — nothing to walk. Refusing here would turn an
    // unanswerable question into a confident wrong answer, which is the one
    // failure mode worse than the silence being fixed.
    useThreeRef.getState().setRenderRefs(null, null);
    selectNode('n_whatever');
    expect(toggleViewLock()).toEqual({ kind: 'locked' });
  });

  it('releasing is never refused, whatever the scene says', () => {
    // Releasing must not consult followability: a lock taken when the character
    // was there has to be releasable after it is gone.
    stage('n_box', [drawable()]);
    selectNode('n_box');
    toggleViewLock();
    stage('n_light', []);
    selectNode('n_light');
    expect(toggleViewLock()).toEqual({ kind: 'released' });
    expect(useViewportStore.getState().viewLock).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { DagState } from '../core/dag/state';
import {
  armatureModeOf,
  isArmatureObject,
  setArmatureMode,
  toggleArmatureMode,
  getArmatureMode,
} from './armatureMode';
import { useArmatureModeStore } from './stores/armatureModeStore';
import { useSelectionStore } from './stores/selectionStore';
import { useDagStore } from '../core/dag/store';

const state = {
  nodes: {
    rig: { id: 'rig', type: 'Object', params: {}, inputs: { data: { node: 'skel' } } },
    skel: { id: 'skel', type: 'Skeleton', params: {}, inputs: {} },
    cube: { id: 'cube', type: 'Object', params: {}, inputs: { data: { node: 'box' } } },
    box: { id: 'box', type: 'BoxData', params: {}, inputs: {} },
  },
} as unknown as DagState;

describe('which nodes have armature modes', () => {
  it('an Object whose data is a Skeleton, and nothing else', () => {
    expect(isArmatureObject(state, 'rig')).toBe(true);
    expect(isArmatureObject(state, 'cube')).toBe(false);
    expect(isArmatureObject(state, 'skel')).toBe(false);
    expect(isArmatureObject(state, null)).toBe(false);
    expect(isArmatureObject(state, 'missing')).toBe(false);
  });
});

describe('which mode is live', () => {
  it('the stored mode while its armature is the primary selection, object otherwise', () => {
    const stored = { nodeId: 'rig', mode: 'pose' as const };
    expect(armatureModeOf('rig', stored)).toBe('pose');
    expect(armatureModeOf('cube', stored)).toBe('object');
    expect(armatureModeOf(null, stored)).toBe('object');
  });
});

describe('Tab and Ctrl+Tab', () => {
  beforeEach(() => {
    useDagStore.setState({ state } as never);
    useArmatureModeStore.getState().clear();
    useSelectionStore.getState().select('rig');
  });

  it('toggle Edit and Pose on an armature, and switch straight from one to the other', () => {
    expect(toggleArmatureMode('edit')).toBe(true);
    expect(getArmatureMode()).toBe('edit');
    expect(toggleArmatureMode('pose')).toBe(true);
    expect(getArmatureMode()).toBe('pose');
    expect(toggleArmatureMode('pose')).toBe(true);
    expect(getArmatureMode()).toBe('object');
  });

  it('are refused for anything that is not an armature, so the key keeps its other meaning', () => {
    useSelectionStore.getState().select('cube');
    expect(toggleArmatureMode('edit')).toBe(false);
    expect(setArmatureMode('pose')).toBe(false);
    expect(getArmatureMode()).toBe('object');
  });
});

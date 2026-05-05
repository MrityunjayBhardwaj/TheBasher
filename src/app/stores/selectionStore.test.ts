// selectionStore — verify the multi-select surface holds the contracts the
// gizmo + Inspector + KeyboardShortcuts + MenuBar all rely on:
//   - primaryNodeId tracks the most-recently-touched id
//   - selectedNodeId mirrors primaryNodeId (deprecated but load-bearing)
//   - selectedNodeIds is a real Set (not array) so callers can probe O(1)

import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from './selectionStore';

beforeEach(() => {
  useSelectionStore.setState({
    selectedNodeIds: new Set(),
    primaryNodeId: null,
    selectedNodeId: null,
  });
});

describe('selectionStore', () => {
  it('select replaces the multi-set and updates both primary mirrors', () => {
    useSelectionStore.getState().select('a');
    const s = useSelectionStore.getState();
    expect([...s.selectedNodeIds]).toEqual(['a']);
    expect(s.primaryNodeId).toBe('a');
    expect(s.selectedNodeId).toBe('a');
  });

  it('select(null) clears everything', () => {
    useSelectionStore.getState().select('a');
    useSelectionStore.getState().select(null);
    const s = useSelectionStore.getState();
    expect(s.selectedNodeIds.size).toBe(0);
    expect(s.primaryNodeId).toBeNull();
    expect(s.selectedNodeId).toBeNull();
  });

  it('selectAdditive toggles membership; primary follows the most-recent change', () => {
    const sel = useSelectionStore.getState();
    sel.selectAdditive('a');
    sel.selectAdditive('b');
    let s = useSelectionStore.getState();
    expect(new Set(s.selectedNodeIds)).toEqual(new Set(['a', 'b']));
    expect(s.primaryNodeId).toBe('b');

    sel.selectAdditive('b'); // toggle off
    s = useSelectionStore.getState();
    expect([...s.selectedNodeIds]).toEqual(['a']);
    expect(s.primaryNodeId).toBe('a');
  });

  it('selectAll replaces with the supplied list; primary is the last id', () => {
    useSelectionStore.getState().selectAll(['a', 'b', 'c']);
    const s = useSelectionStore.getState();
    expect(s.selectedNodeIds.size).toBe(3);
    expect(s.primaryNodeId).toBe('c');
  });

  it('invert returns the complement against the universe', () => {
    useSelectionStore.getState().select('a');
    useSelectionStore.getState().invert(['a', 'b', 'c']);
    const s = useSelectionStore.getState();
    expect(new Set(s.selectedNodeIds)).toEqual(new Set(['b', 'c']));
  });

  it('clear empties everything atomically', () => {
    useSelectionStore.getState().selectAll(['a', 'b']);
    useSelectionStore.getState().clear();
    const s = useSelectionStore.getState();
    expect(s.selectedNodeIds.size).toBe(0);
    expect(s.primaryNodeId).toBeNull();
    expect(s.selectedNodeId).toBeNull();
  });

  it('selectMany supports the menu By-Type pattern', () => {
    useSelectionStore.getState().selectMany(['x', 'y']);
    const s = useSelectionStore.getState();
    expect(new Set(s.selectedNodeIds)).toEqual(new Set(['x', 'y']));
    expect(s.primaryNodeId).toBe('y');
  });
});

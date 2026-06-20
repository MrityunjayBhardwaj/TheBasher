// selectNodeOnClick — the ONE viewport selection handler (#211). These assert the
// shared core behaves like the three pickers it replaced (SceneChildNode,
// LightHelpers, CameraHelper): select / shift-additive / stopPropagation, and a
// null pickId is a no-op that does NOT stopPropagation (so an unroutable click
// falls through to OrbitControls).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from '../app/stores/selectionStore';
import { selectNode, selectNodeOnClick } from './selectNodeOnClick';

function fakeEvent(shiftKey = false) {
  return { stopPropagation: vi.fn(), shiftKey };
}

describe('selectNodeOnClick', () => {
  beforeEach(() => {
    useSelectionStore.getState().select(null); // reset selection
  });

  it('selects the picked node and stops propagation', () => {
    const e = fakeEvent();
    selectNode('n_box', e);
    expect(useSelectionStore.getState().primaryNodeId).toBe('n_box');
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('shift adds to the multi-select set', () => {
    selectNode('n_a', fakeEvent(false));
    selectNode('n_b', fakeEvent(true)); // shift → additive
    const sel = useSelectionStore.getState();
    expect(sel.primaryNodeId).toBe('n_b');
    expect(sel.selectedNodeIds.has('n_a')).toBe(true);
    expect(sel.selectedNodeIds.has('n_b')).toBe(true);
  });

  it('a null pickId is a no-op and does NOT stop propagation (falls through)', () => {
    useSelectionStore.getState().select('n_keep');
    const e = fakeEvent();
    selectNode(null, e);
    expect(useSelectionStore.getState().primaryNodeId).toBe('n_keep'); // unchanged
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('selectNodeOnClick returns a handler that selects on invocation', () => {
    const handler = selectNodeOnClick('n_light');
    const e = fakeEvent();
    handler(e);
    expect(useSelectionStore.getState().primaryNodeId).toBe('n_light');
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

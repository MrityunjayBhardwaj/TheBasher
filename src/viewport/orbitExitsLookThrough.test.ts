// orbitExitsLookThrough — an orbit drag in camera view comes back to the free view; a click, a
// gizmo drag and a drag in the free view change nothing (#1708).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachOrbitExitsLookThrough } from './orbitExitsLookThrough';
import { useViewportStore } from '../app/stores/viewportStore';
import { useGizmoStore } from '../app/stores/gizmoStore';

function pointer(type: string, x: number, y: number, buttons: number): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, buttons, bubbles: true });
}

describe('attachOrbitExitsLookThrough', () => {
  let el: HTMLElement;
  let detach: () => void;
  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    detach = attachOrbitExitsLookThrough(el);
    useViewportStore.getState().setLookThroughCamera(true);
    useGizmoStore.setState({ dragging: false });
  });
  afterEach(() => {
    detach();
    el.remove();
    useViewportStore.getState().setLookThroughCamera(false);
    useGizmoStore.setState({ dragging: false });
  });

  it('leaves camera view once a pressed pointer travels past the click threshold', () => {
    el.dispatchEvent(pointer('pointerdown', 100, 100, 1));
    el.dispatchEvent(pointer('pointermove', 102, 101, 1));
    expect(useViewportStore.getState().lookThroughCamera).toBe(true);
    el.dispatchEvent(pointer('pointermove', 120, 104, 1));
    expect(useViewportStore.getState().lookThroughCamera).toBe(false);
  });

  it('keeps camera view for a click, a hover and a gizmo drag', () => {
    el.dispatchEvent(pointer('pointerdown', 100, 100, 1));
    window.dispatchEvent(pointer('pointerup', 100, 100, 0));
    el.dispatchEvent(pointer('pointermove', 160, 160, 0));
    expect(useViewportStore.getState().lookThroughCamera).toBe(true);

    el.dispatchEvent(pointer('pointerdown', 100, 100, 1));
    useGizmoStore.setState({ dragging: true });
    el.dispatchEvent(pointer('pointermove', 160, 160, 1));
    expect(useViewportStore.getState().lookThroughCamera).toBe(true);
  });

  it('does nothing for a drag that started in the free view', () => {
    useViewportStore.getState().setLookThroughCamera(false);
    el.dispatchEvent(pointer('pointerdown', 100, 100, 1));
    useViewportStore.getState().setLookThroughCamera(true);
    el.dispatchEvent(pointer('pointermove', 160, 160, 1));
    expect(useViewportStore.getState().lookThroughCamera).toBe(true);
  });

  it('stops listening once detached', () => {
    detach();
    el.dispatchEvent(pointer('pointerdown', 100, 100, 1));
    el.dispatchEvent(pointer('pointermove', 160, 160, 1));
    expect(useViewportStore.getState().lookThroughCamera).toBe(true);
    detach = () => {};
  });
});

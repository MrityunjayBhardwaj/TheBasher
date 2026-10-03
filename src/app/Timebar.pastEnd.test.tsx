// #1287 — content that runs past the scene's End is said, and Extend moves End to fit it.
//
// The issue's last line: "a clip that runs past the range should say so, rather than quietly
// stopping". End stays where the director put it (Blender's behaviour); the Timebar names what
// runs past it, and Extend is the one action that turns the notice off.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp } from '../core/dag';
import type { DagState } from '../core/dag/state';
import { useDagStore } from '../core/dag/store';
import type { Op } from '../core/dag/types';
import { buildDefaultDagState } from '../core/project/default';
import { registerAllNodes } from '../nodes/registerAll';
import { sceneEndSeconds } from './sceneRange';
import { useEditorStore } from './stores/editorStore';
import { Timebar } from './Timebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

/** The default scene plus a motion clip of `seconds`, named as a generated walk is. */
function withClip(seconds: number): DagState {
  return applyOp(buildDefaultDagState(), {
    type: 'addNode',
    nodeId: 'clip',
    nodeType: 'AnimationClip',
    params: { name: 'a person walks forward', duration: seconds },
  } as Op).next;
}

let container: HTMLDivElement;
let root: Root;
const notice = () => container.querySelector('[data-testid="timebar-past-end"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useEditorStore.getState().setSpace('view3d');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('#1287 — the Timebar says when content runs past End', () => {
  it('a 12.1 s walk with End at 10 s is named, with where it ends', () => {
    act(() => useDagStore.getState().hydrate(withClip(12.1)));
    act(() => root.render(<Timebar />));
    expect(notice()?.textContent).toContain('Extend to 12.10s');
    // Who runs past, and what End does to it, are its accessible name.
    expect(notice()?.getAttribute('aria-label')).toContain(
      'a person walks forward runs to 12.10s, past End (10.00s)',
    );
  });

  it('Extend moves End to the walk’s end, as one undoable edit, and the notice goes', () => {
    act(() => useDagStore.getState().hydrate(withClip(12.1)));
    act(() => root.render(<Timebar />));
    act(() => (notice() as HTMLButtonElement).click());
    expect(sceneEndSeconds(useDagStore.getState().state)).toBeCloseTo(12.1, 6);
    expect(notice()).toBeNull();
    act(() => useDagStore.getState().undo());
    expect(sceneEndSeconds(useDagStore.getState().state)).toBe(10);
    expect(notice()).not.toBeNull();
  });

  it('content that ends inside End says nothing', () => {
    act(() => useDagStore.getState().hydrate(withClip(9.97)));
    act(() => root.render(<Timebar />));
    expect(notice()).toBeNull();
  });

  it('in Video mode, where the range is the composition’s, it says nothing', () => {
    act(() => useDagStore.getState().hydrate(withClip(12.1)));
    act(() => useEditorStore.getState().setSpace('video'));
    act(() => root.render(<Timebar />));
    expect(notice()).toBeNull();
  });
});

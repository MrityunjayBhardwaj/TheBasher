// #1709 — the split/outliner fold rule: the split showing folds the outliner; the split going
// away restores it only if the rule folded it and the director has not touched it since.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installSplitOutlinerFold, splitShowing } from './splitOutlinerFold';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { DEFAULT_SPLIT_STATE, useSplitViewStore } from './stores/splitViewStore';
import { useTwoDViewStore } from './stores/twoDViewStore';

let width = 1440;
let off: () => void = () => {};
const folded = () => useChromeStore.getState().leftSidebarCollapsed;
const space = (s: 'view3d' | 'uv') => useEditorStore.getState().setSpace(s);

beforeEach(() => {
  useEditorStore.setState({ space: 'view3d' });
  useTwoDViewStore.setState({ mode: 'uv' });
  useSplitViewStore.setState({ ...DEFAULT_SPLIT_STATE });
  useChromeStore.setState({ leftSidebarCollapsed: false });
  width = 1440;
  off = installSplitOutlinerFold(() => width);
});
afterEach(() => off());

describe('splitShowing', () => {
  it('is the 2D space, in a split mode, with the 3D side expanded', () => {
    const on = { split: { uv: true, render: false }, collapsed: false };
    expect(splitShowing('uv', 'uv', on)).toBe(true);
    expect(splitShowing('view3d', 'uv', on)).toBe(false);
    expect(splitShowing('uv', 'render', on)).toBe(false);
    expect(splitShowing('uv', 'uv', { ...on, collapsed: true })).toBe(false);
  });
});

describe('installSplitOutlinerFold', () => {
  it('folds when the split shows and restores on every way it goes', () => {
    const leave: [string, () => void, () => void][] = [
      [
        'split off',
        () => useSplitViewStore.getState().setSplit('uv', false),
        () => useSplitViewStore.getState().setSplit('uv', true),
      ],
      [
        'collapse',
        () => useSplitViewStore.getState().setCollapsed(true),
        () => useSplitViewStore.getState().setCollapsed(false),
      ],
      [
        'render',
        () => useTwoDViewStore.getState().setMode('render'),
        () => useTwoDViewStore.getState().setMode('uv'),
      ],
      ['leave 2D', () => space('view3d'), () => space('uv')],
    ];
    space('uv');
    expect(folded()).toBe(true);
    for (const [name, go, back] of leave) {
      go();
      expect(folded(), `restored: ${name}`).toBe(false);
      back();
      expect(folded(), `folded again after ${name}`).toBe(true);
    }
  });

  it('leaves an outliner the director re-opened during the split open', () => {
    space('uv');
    useChromeStore.getState().toggleLeftSidebar();
    expect(folded()).toBe(false);
    space('view3d');
    expect(folded()).toBe(false);
  });

  it('leaves an outliner the director folded themselves folded', () => {
    useChromeStore.getState().setLeftSidebarCollapsed(true);
    space('uv');
    space('view3d');
    expect(folded()).toBe(true);
    // ...and one they re-folded during the split (after re-opening it) is theirs too.
    useChromeStore.getState().setLeftSidebarCollapsed(false);
    space('uv');
    useChromeStore.getState().setLeftSidebarCollapsed(false);
    useChromeStore.getState().setLeftSidebarCollapsed(true);
    space('view3d');
    expect(folded()).toBe(true);
  });

  it('does nothing in the narrow layout, where the outliner is an overlay drawer', () => {
    width = 900;
    space('uv');
    expect(folded()).toBe(false);
  });
});

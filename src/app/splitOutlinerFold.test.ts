// #1709 — the split/outliner fold rule: the split showing folds the outliner; the split going
// away restores it only if the rule folded it and the director has not touched it since.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installSplitOutlinerFold, splitShowing } from './splitOutlinerFold';
import { useChromeStore } from './stores/chromeStore';
import { useEditorStore } from './stores/editorStore';
import { coerceSplitState, DEFAULT_SPLIT_STATE, useSplitViewStore } from './stores/splitViewStore';
import { useTwoDViewStore } from './stores/twoDViewStore';

// The saved split record is what a reload reads back, so the stores need a working Storage (the
// test environment's is a partial stub); the stores call it lazily, so installing it here is in time.
beforeAll(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
  });
});

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

  // #1952 — a fresh start boots the outliner as a rail. That rail was folded by the default, not by
  // this rule: the split must neither claim it (and open it on the way out) nor lose track of a
  // director who opens it during the split.
  it("a first-start rail is not the rule's to restore: the split comes and goes and it stays a rail", () => {
    off();
    useChromeStore.setState({ leftSidebarCollapsed: true });
    off = installSplitOutlinerFold(() => width);
    space('uv');
    expect(useSplitViewStore.getState().outlinerFoldedBySplit).toBe(false);
    space('view3d');
    expect(folded()).toBe(true);
    // ...and opened during the split, it is the director's: closing the split leaves it open.
    space('uv');
    useChromeStore.getState().toggleLeftSidebar();
    space('view3d');
    expect(folded()).toBe(false);
  });

  it('does nothing in the narrow layout, where the outliner is an overlay drawer', () => {
    width = 900;
    space('uv');
    expect(folded()).toBe(false);
  });

  // A reload: the rule unmounts, the split store comes back from its saved bytes (coerced), the
  // editor opens again, the rule mounts again.
  const reload = (spaceAfter: 'view3d' | 'uv') => {
    off();
    const saved = localStorage.getItem('basher.splitView.v1');
    useSplitViewStore.setState(coerceSplitState(saved ? JSON.parse(saved) : null));
    useEditorStore.setState({ space: spaceAfter });
    off = installSplitOutlinerFold(() => width);
  };

  it('remembers across a reload during the split: closing the split afterwards restores it', () => {
    space('uv');
    expect(folded()).toBe(true);
    reload('uv');
    expect(folded()).toBe(true);
    useSplitViewStore.getState().setSplit('uv', false);
    expect(folded(), 'restored after the reload').toBe(false);
  });

  it('a reload that lands outside the split restores it at once', () => {
    space('uv');
    reload('view3d');
    expect(folded()).toBe(false);
    expect(useSplitViewStore.getState().outlinerFoldedBySplit).toBe(false);
  });

  it('a reload after the director took the outliner over leaves it as they set it', () => {
    space('uv');
    useChromeStore.getState().toggleLeftSidebar();
    useChromeStore.getState().toggleLeftSidebar();
    expect(folded()).toBe(true);
    reload('uv');
    useSplitViewStore.getState().setSplit('uv', false);
    expect(folded()).toBe(true);
  });
});

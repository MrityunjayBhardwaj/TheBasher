// #1953 — the Nodes panel folds the inspector while it shows, and gives it back only if it folded
// it and the director has not touched it since.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installChatInspectorFold } from './chatInspectorFold';
import { installNodesInspectorFold, nodesPanelShowing } from './nodesInspectorFold';
import { useChatColumnStore } from './stores/chatColumnStore';
import { useChromeStore } from './stores/chromeStore';
import { useNodesTabStore } from './stores/nodesTabStore';
import { useTimelineDockStore } from './stores/timelineDockStore';
import { useViewportStore } from './stores/viewportStore';

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
const inspectorFolded = () => useChromeStore.getState().inspectorCollapsed;
const openNodes = () => {
  useTimelineDockStore.getState().setActiveTab('nodes');
  useViewportStore.getState().setTimelineDrawerOpen(true);
};
const closeDrawer = () => useViewportStore.getState().setTimelineDrawerOpen(false);

beforeEach(() => {
  useViewportStore.getState().setTimelineDrawerOpen(false);
  useTimelineDockStore.getState().setActiveTab('dopesheet');
  useNodesTabStore.setState({ panelOpen: true, inspectorFoldedByPanel: false });
  useChromeStore.setState({ inspectorCollapsed: false });
  width = 1440;
  off = installNodesInspectorFold(() => width);
});
afterEach(() => off());

describe('nodesPanelShowing', () => {
  it('is the drawer open on the Nodes tab with its panel unfolded', () => {
    expect(nodesPanelShowing(true, 'nodes', true)).toBe(true);
    expect(nodesPanelShowing(false, 'nodes', true)).toBe(false);
    expect(nodesPanelShowing(true, 'dopesheet', true)).toBe(false);
    expect(nodesPanelShowing(true, 'nodes', false)).toBe(false);
  });
});

describe('installNodesInspectorFold', () => {
  it('folds the inspector when the panel shows and restores it every way it goes', () => {
    const leave: [string, () => void, () => void][] = [
      ['drawer closed', closeDrawer, openNodes],
      [
        'another tab',
        () => useTimelineDockStore.getState().setActiveTab('curve'),
        () => useTimelineDockStore.getState().setActiveTab('nodes'),
      ],
      [
        'panel folded (N)',
        () => useNodesTabStore.getState().togglePanel(),
        () => useNodesTabStore.getState().togglePanel(),
      ],
    ];
    openNodes();
    expect(inspectorFolded()).toBe(true);
    for (const [name, go, back] of leave) {
      go();
      expect(inspectorFolded(), `restored: ${name}`).toBe(false);
      back();
      expect(inspectorFolded(), `folded again after ${name}`).toBe(true);
    }
  });

  it('an inspector already a rail is not the rule’s: it stays a rail after', () => {
    useChromeStore.getState().setInspectorCollapsed(true);
    openNodes();
    expect(useNodesTabStore.getState().inspectorFoldedByPanel).toBe(false);
    closeDrawer();
    expect(inspectorFolded()).toBe(true);
  });

  it('an inspector the director opens while the panel shows is theirs: it stays open', () => {
    openNodes();
    useChromeStore.getState().toggleInspector();
    expect(inspectorFolded()).toBe(false);
    closeDrawer();
    expect(inspectorFolded()).toBe(false);
    // ...and one they open and fold again themselves stays folded.
    openNodes();
    useChromeStore.getState().toggleInspector();
    useChromeStore.getState().toggleInspector();
    closeDrawer();
    expect(inspectorFolded()).toBe(true);
  });

  it('does nothing in the narrow layout, where the inspector is an overlay drawer', () => {
    width = 900;
    openNodes();
    expect(inspectorFolded()).toBe(false);
  });

  it('a reload (the drawer comes back closed) restores what the rule folded', () => {
    openNodes();
    expect(inspectorFolded()).toBe(true);
    off();
    useViewportStore.getState().setTimelineDrawerOpen(false);
    off = installNodesInspectorFold(() => width);
    expect(inspectorFolded()).toBe(false);
    expect(useNodesTabStore.getState().inspectorFoldedByPanel).toBe(false);
  });

  it('its restore is not a director’s unfold: the chat rule leaves chat open', () => {
    const offChat = installChatInspectorFold(() => width);
    try {
      useChatColumnStore.setState({ open: true, narrowOpen: false, unread: false });
      openNodes();
      expect(inspectorFolded()).toBe(true);
      closeDrawer();
      expect(inspectorFolded()).toBe(false);
      expect(useChatColumnStore.getState().open).toBe(true);
    } finally {
      offChat();
    }
  });
});

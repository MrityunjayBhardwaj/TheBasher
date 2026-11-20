// #1704 — the fold rule: at ≤ 1440 px opening chat folds the inspector and unfolding the inspector
// folds chat; transitions only; nothing above the limit or in the narrow layout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  foldRuleApplies,
  installChatInspectorFold,
  unfoldInspectorKeepingChat,
} from './chatInspectorFold';
import { useChatColumnStore } from './stores/chatColumnStore';
import { useChromeStore } from './stores/chromeStore';

let width = 1440;
let off: () => void = () => {};

beforeEach(() => {
  useChatColumnStore.setState({ open: true, narrowOpen: false, unread: false });
  useChromeStore.setState({ inspectorCollapsed: false });
  width = 1440;
  off = installChatInspectorFold(() => width);
});
afterEach(() => off());

describe('foldRuleApplies', () => {
  it('holds from the narrow breakpoint up to 1440 inclusive', () => {
    expect(foldRuleApplies(1440)).toBe(true);
    expect(foldRuleApplies(1280)).toBe(true);
    expect(foldRuleApplies(1441)).toBe(false);
    expect(foldRuleApplies(900)).toBe(false);
  });
});

describe('installChatInspectorFold', () => {
  it('leaves an existing both-open state alone (no transition, no fold)', () => {
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
    expect(useChatColumnStore.getState().open).toBe(true);
  });

  it('opening chat folds the inspector; folding chat does not touch it', () => {
    useChatColumnStore.getState().setVisible(false, false);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
    useChatColumnStore.getState().setVisible(false, true);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(true);
  });

  it('unfolding the inspector folds chat; folding the inspector does not touch chat', () => {
    useChromeStore.getState().setInspectorCollapsed(true);
    expect(useChatColumnStore.getState().open).toBe(true);
    useChromeStore.getState().toggleInspector();
    expect(useChatColumnStore.getState().open).toBe(false);
  });

  it('#1706 — an unfold by navigation (from the proposal card) keeps chat open; the next user unfold still folds it', () => {
    useChromeStore.getState().setInspectorCollapsed(true);
    unfoldInspectorKeepingChat();
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
    expect(useChatColumnStore.getState().open).toBe(true);
    useChromeStore.getState().setInspectorCollapsed(true);
    useChromeStore.getState().toggleInspector();
    expect(useChatColumnStore.getState().open).toBe(false);
  });

  it('does nothing above 1440 px', () => {
    width = 1600;
    useChatColumnStore.getState().setVisible(false, false);
    useChatColumnStore.getState().setVisible(false, true);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
    useChromeStore.getState().setInspectorCollapsed(true);
    useChromeStore.getState().setInspectorCollapsed(false);
    expect(useChatColumnStore.getState().open).toBe(true);
  });

  it('the narrow chat drawer opening is not a desktop open', () => {
    width = 900;
    useChatColumnStore.getState().setVisible(true, true);
    expect(useChromeStore.getState().inspectorCollapsed).toBe(false);
  });
});

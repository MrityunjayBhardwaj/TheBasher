// chatColumnStore (#1704) — the desktop column persists open/folded, the narrow drawer and the
// unread dot do not, and a reply counts only once it carries something.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../agent/session/store';

const backing = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: (i: number) => Array.from(backing.keys())[i] ?? null,
      get length() {
        return backing.size;
      },
    },
  });
});

const STORAGE_KEY = 'basher.chatColumn.v1';

async function freshStore() {
  vi.resetModules();
  return import('./chatColumnStore');
}

describe('chatColumnStore', () => {
  beforeEach(() => backing.clear());

  it('boots open on the desktop and closed as a narrow drawer, with no unread dot', async () => {
    const { useChatColumnStore } = await freshStore();
    expect(useChatColumnStore.getState()).toMatchObject({
      open: true,
      narrowOpen: false,
      unread: false,
    });
  });

  it('remembers a folded desktop column across a reload', async () => {
    const first = await freshStore();
    expect(first.useChatColumnStore.getState().toggle(false)).toBe(false);
    expect(JSON.parse(backing.get(STORAGE_KEY) ?? '{}')).toEqual({ open: false });
    const second = await freshStore();
    expect(second.useChatColumnStore.getState().open).toBe(false);
  });

  it('never persists the narrow drawer: a reload boots it closed', async () => {
    const first = await freshStore();
    expect(first.useChatColumnStore.getState().toggle(true)).toBe(true);
    expect(first.useChatColumnStore.getState().open, 'desktop flag untouched').toBe(true);
    const second = await freshStore();
    expect(second.useChatColumnStore.getState().narrowOpen).toBe(false);
  });

  it('coerces a corrupt or foreign record to the default', async () => {
    backing.set(STORAGE_KEY, '{"open":"yes"}');
    expect((await freshStore()).useChatColumnStore.getState().open).toBe(true);
    backing.set(STORAGE_KEY, 'not json');
    expect((await freshStore()).useChatColumnStore.getState().open).toBe(true);
  });

  it('showing the chat clears the unread dot; folding it does not', async () => {
    const { useChatColumnStore } = await freshStore();
    useChatColumnStore.getState().setVisible(false, false);
    useChatColumnStore.getState().setUnread(true);
    useChatColumnStore.getState().setVisible(false, false);
    expect(useChatColumnStore.getState().unread).toBe(true);
    useChatColumnStore.getState().setVisible(false, true);
    expect(useChatColumnStore.getState().unread).toBe(false);
  });

  it('chatVisible reads the flag for the layout in force', async () => {
    const { chatVisible } = await freshStore();
    const s = { open: true, narrowOpen: false, unread: false };
    expect(chatVisible(s, false)).toBe(true);
    expect(chatVisible(s, true)).toBe(false);
  });
});

describe('agentReplyKey', () => {
  const msg = (over: Partial<Message>): Message => ({
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    ...over,
  });

  it('is empty with no assistant message, or while the round’s bubble is still blank', async () => {
    const { agentReplyKey } = await freshStore();
    expect(agentReplyKey([])).toBe('');
    expect(agentReplyKey([msg({ role: 'user', content: 'hi' })])).toBe('');
    expect(agentReplyKey([msg({ role: 'user', content: 'hi', id: 'u' }), msg({})])).toBe('');
  });

  it('changes as the reply gains text, a summary or a step', async () => {
    const { agentReplyKey } = await freshStore();
    const a = agentReplyKey([msg({ content: 'He' })]);
    const b = agentReplyKey([msg({ content: 'Hello' })]);
    const c = agentReplyKey([msg({ content: 'Hello', summary: 'Added 3 cubes' })]);
    const d = agentReplyKey([
      msg({
        content: 'Hello',
        summary: 'Added 3 cubes',
        steps: [{ tool: 't', detail: '', refused: false }],
      }),
    ]);
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).not.toBe('');
  });
});

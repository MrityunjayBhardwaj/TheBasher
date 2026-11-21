// #1957 — the stack frame's switch is remembered across reloads, and a bad record falls back.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

const KEY = 'basher.stackFrame.v1';
const fresh = async () => {
  vi.resetModules();
  return (await import('./stackFrameStore')).useStackFrameStore;
};

describe('stackFrameStore', () => {
  afterEach(() => localStorage.clear());

  it('starts on Modifiers', async () => {
    expect((await fresh()).getState().stack).toBe('modifiers');
  });

  it('remembers the pick across a reload', async () => {
    (await fresh()).getState().setStack('materials');
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ stack: 'materials' });
    expect((await fresh()).getState().stack).toBe('materials');
  });

  it('a record it cannot read falls back to Modifiers', async () => {
    localStorage.setItem(KEY, JSON.stringify({ stack: 'anim' }));
    expect((await fresh()).getState().stack).toBe('modifiers');
    localStorage.setItem(KEY, '{not json');
    expect((await fresh()).getState().stack).toBe('modifiers');
  });

  it('refuses a value that is no stack', async () => {
    const store = await fresh();
    store.getState().setStack('constraints');
    store.getState().setStack('nope' as never);
    expect(store.getState().stack).toBe('constraints');
  });
});

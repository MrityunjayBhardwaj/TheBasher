// viewLockPersistence — the view lock, remembered per project (#985).
//
// #856 asked for two things and the lock answered one; this is the other half,
// so the rows below are about SURVIVING A RELOAD and about the two ways that
// could go quietly wrong: a lock filed under the wrong project, and a released
// lock coming back.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// happy-dom's localStorage is non-functional in this vitest config — install a
// plain in-memory implementation BEFORE importing the module (mirrors
// editorViewPersistence.test.ts).
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

import { loadViewLock, saveViewLock } from './viewLockPersistence';

beforeEach(() => {
  localStorage.clear();
});

describe('viewLockPersistence', () => {
  it('round-trips a lock with its bone', () => {
    saveViewLock('proj-a', { nodeId: 'n_char', boneName: 'mixamorigHips' });
    expect(loadViewLock('proj-a')).toEqual({ nodeId: 'n_char', boneName: 'mixamorigHips' });
  });

  it('round-trips a lock on the rig as a whole', () => {
    saveViewLock('proj-a', { nodeId: 'n_char', boneName: null });
    expect(loadViewLock('proj-a')).toEqual({ nodeId: 'n_char', boneName: null });
  });

  it('keeps each project to its own lock, because a node id means nothing outside one', () => {
    // Not a tidiness preference. Both projects here carry a node called `n_box`,
    // which is what a shared default seed produces — a single global key would
    // restore B's lock onto A's box and resolve, which is a wrong answer that
    // looks right.
    saveViewLock('proj-a', { nodeId: 'n_box', boneName: null });
    saveViewLock('proj-b', { nodeId: 'n_char', boneName: 'Hips' });
    expect(loadViewLock('proj-a')).toEqual({ nodeId: 'n_box', boneName: null });
    expect(loadViewLock('proj-b')).toEqual({ nodeId: 'n_char', boneName: 'Hips' });
    expect(loadViewLock('proj-c')).toBeNull();
  });

  it('a released lock does not come back', () => {
    // The applier clears a lock whose node has left the graph, and that clearing
    // reaches this function as `null`. Writing a null instead of removing the
    // entry would be a second spelling of absent, and the row that would notice
    // is this one: nothing distinguishes the two on the way back out.
    saveViewLock('proj-a', { nodeId: 'n_char', boneName: 'Hips' });
    saveViewLock('proj-a', null);
    expect(loadViewLock('proj-a')).toBeNull();
    expect(localStorage.getItem('basher.viewLock.proj-a')).toBeNull();
  });

  it('treats a malformed or foreign entry as absent rather than restoring half of it', () => {
    for (const bad of [
      'not json',
      'null',
      '"a string"',
      '{}',
      '{"nodeId":""}',
      '{"nodeId":123}',
      '{"nodeId":"n","boneName":42}',
    ]) {
      localStorage.setItem('basher.viewLock.proj-a', bad);
      expect(loadViewLock('proj-a'), bad).toBeNull();
    }
    // ...and the losing alternative: a well-formed entry beside them, so the
    // rows above are not satisfied by a loader that returns null for everything.
    localStorage.setItem('basher.viewLock.proj-a', '{"nodeId":"n","boneName":"Hips"}');
    expect(loadViewLock('proj-a')).toEqual({ nodeId: 'n', boneName: 'Hips' });
  });

  it('accepts an entry with no bone at all, which is the same as following the rig', () => {
    localStorage.setItem('basher.viewLock.proj-a', '{"nodeId":"n_char"}');
    expect(loadViewLock('proj-a')).toEqual({ nodeId: 'n_char', boneName: null });
  });

  it('does nothing without a project, in both directions', () => {
    // Boot's home route has no current project. A save keyed on '' would collect
    // every projectless lock in one bucket and hand it to whichever project
    // opened next.
    saveViewLock(null, { nodeId: 'n_char', boneName: null });
    saveViewLock(undefined, { nodeId: 'n_char', boneName: null });
    saveViewLock('', { nodeId: 'n_char', boneName: null });
    expect(localStorage.length).toBe(0);
    expect(loadViewLock(null)).toBeNull();
    expect(loadViewLock('')).toBeNull();
  });
});

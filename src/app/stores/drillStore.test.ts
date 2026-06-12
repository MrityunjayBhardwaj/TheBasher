import { describe, it, expect, beforeEach } from 'vitest';
import { useDrillStore } from './drillStore';

const CHAIN = ['asset', 'body', 'wheel', 'bolt']; // depth 0..3

describe('useDrillStore', () => {
  beforeEach(() => useDrillStore.getState().reset());

  it('first drill on a fresh chain selects the first child (index 1)', () => {
    expect(useDrillStore.getState().drillInto(CHAIN)).toBe('body');
    expect(useDrillStore.getState().index).toBe(1);
  });

  it('repeated drills on the SAME chain march one level deeper', () => {
    const d = () => useDrillStore.getState().drillInto(CHAIN);
    expect(d()).toBe('body'); // 1
    expect(d()).toBe('wheel'); // 2
    expect(d()).toBe('bolt'); // 3 (leaf)
  });

  it('drilling past the leaf wraps back to the first child', () => {
    const d = () => useDrillStore.getState().drillInto(CHAIN);
    d();
    d();
    d(); // at bolt
    expect(d()).toBe('body'); // wrap
  });

  it('a NEW object (different chain) restarts at its first child', () => {
    useDrillStore.getState().drillInto(CHAIN); // body
    useDrillStore.getState().drillInto(CHAIN); // wheel
    // double-click a different model
    expect(useDrillStore.getState().drillInto(['asset2', 'door'])).toBe('door');
    expect(useDrillStore.getState().index).toBe(1);
  });

  it('a flat chain (asset → one child) selects that child', () => {
    expect(useDrillStore.getState().drillInto(['asset', 'body'])).toBe('body');
  });

  it('popOut walks back up a level at a time, then null at the top', () => {
    const d = () => useDrillStore.getState().drillInto(CHAIN);
    d();
    d();
    d(); // bolt (index 3)
    const pop = () => useDrillStore.getState().popOut();
    expect(pop()).toBe('wheel'); // 2
    expect(pop()).toBe('body'); // 1
    expect(pop()).toBe('asset'); // 0
    expect(pop()).toBeNull(); // past the top → clear
  });

  it('drill resumes deeper after a popOut (Esc up, dbl-click down are symmetric)', () => {
    const d = () => useDrillStore.getState().drillInto(CHAIN);
    d();
    d();
    d(); // bolt
    useDrillStore.getState().popOut(); // → wheel (index 2)
    expect(d()).toBe('bolt'); // same chain, deeper again
  });

  it('reset clears all drill state', () => {
    useDrillStore.getState().drillInto(CHAIN);
    useDrillStore.getState().reset();
    const s = useDrillStore.getState();
    expect(s.chain).toEqual([]);
    expect(s.index).toBe(0);
    expect(s.sig).toBeNull();
  });
});

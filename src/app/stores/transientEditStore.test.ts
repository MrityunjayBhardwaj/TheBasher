import { describe, it, expect, beforeEach } from 'vitest';
import { useTransientEditStore, keyOf } from './transientEditStore';
import { useTimeStore } from './timeStore';

describe('transientEditStore (A1 — multi-slot V1-exempt UI projection)', () => {
  beforeEach(() => {
    useTransientEditStore.getState().clearAll();
  });

  it('set → get/has returns the held edit', () => {
    const s = useTransientEditStore.getState();
    s.set('node-1', 'position.x', 9);
    expect(s.has('node-1', 'position.x')).toBe(true);
    expect(s.get('node-1', 'position.x')).toEqual({
      nodeId: 'node-1',
      paramPath: 'position.x',
      value: 9,
    });
    expect(s.has('node-1', 'position.y')).toBe(false);
    expect(s.get('node-1', 'position.y')).toBeUndefined();
  });

  it('multi-slot: independent slots coexist (D-149-1)', () => {
    const s = useTransientEditStore.getState();
    s.set('node-1', 'position.x', 9);
    s.set('node-1', 'material.color', '#ff0000');
    s.set('node-2', 'scale', [2, 2, 2]);
    const edits = useTransientEditStore.getState().edits;
    expect(edits.size).toBe(3);
    expect(useTransientEditStore.getState().get('node-1', 'position.x')?.value).toBe(9);
    expect(useTransientEditStore.getState().get('node-1', 'material.color')?.value).toBe('#ff0000');
    expect(useTransientEditStore.getState().get('node-2', 'scale')?.value).toEqual([2, 2, 2]);
  });

  it('set overwrites an existing slot in place (same key)', () => {
    const s = useTransientEditStore.getState();
    s.set('node-1', 'position.x', 9);
    s.set('node-1', 'position.x', 12);
    expect(useTransientEditStore.getState().edits.size).toBe(1);
    expect(useTransientEditStore.getState().get('node-1', 'position.x')?.value).toBe(12);
  });

  it('clear removes ONE slot, leaving others', () => {
    const s = useTransientEditStore.getState();
    s.set('node-1', 'position.x', 9);
    s.set('node-1', 'position.y', 5);
    s.clear('node-1', 'position.x');
    expect(useTransientEditStore.getState().has('node-1', 'position.x')).toBe(false);
    expect(useTransientEditStore.getState().has('node-1', 'position.y')).toBe(true);
  });

  it('clearAll empties every slot', () => {
    const s = useTransientEditStore.getState();
    s.set('node-1', 'position.x', 9);
    s.set('node-2', 'scale', [2, 2, 2]);
    s.clearAll();
    expect(useTransientEditStore.getState().edits.size).toBe(0);
  });

  it('keyOf composes nodeId|paramPath', () => {
    expect(keyOf('n', 'position.x')).toBe('n|position.x');
  });

  // B12 GUARD — the load-bearing assertion: a subscribed selector MUST re-fire
  // on set, because each write produces a NEW Map. A mutate-in-place Map would
  // keep the same ref and the render overlay (Wave B) + orange (Wave F) would
  // never update.
  it('set produces a NEW Map ref so subscribed selectors re-fire (B12)', () => {
    let fireCount = 0;
    let lastRef: unknown = useTransientEditStore.getState().edits;
    const unsub = useTransientEditStore.subscribe((s) => {
      if (s.edits !== lastRef) {
        fireCount += 1;
        lastRef = s.edits;
      }
    });
    useTransientEditStore.getState().set('node-1', 'position.x', 9);
    useTransientEditStore.getState().set('node-1', 'position.y', 5);
    unsub();
    expect(fireCount).toBe(2);
  });

  it('clearAll on an already-empty store does NOT churn the ref (no spurious re-fire)', () => {
    useTransientEditStore.getState().clearAll(); // ensure empty
    const before = useTransientEditStore.getState().edits;
    useTransientEditStore.getState().clearAll();
    expect(useTransientEditStore.getState().edits).toBe(before);
  });

  it('clear on a missing slot does NOT churn the ref', () => {
    const before = useTransientEditStore.getState().edits;
    useTransientEditStore.getState().clear('ghost', 'nope');
    expect(useTransientEditStore.getState().edits).toBe(before);
  });
});

describe('transientEditStore (A2 — frame-INT-change discard, D-149-2)', () => {
  beforeEach(() => {
    useTransientEditStore.getState().clearAll();
    useTimeStore.getState().setTime(0); // frame 0
  });

  it('crossing a frame boundary clears all transients', () => {
    useTransientEditStore.getState().set('node-1', 'position.x', 9);
    expect(useTransientEditStore.getState().has('node-1', 'position.x')).toBe(true);
    // 0.5s → frame 30 (FRAMES_PER_SECOND=60): a frame change.
    useTimeStore.getState().setTime(0.5);
    expect(useTimeStore.getState().frame).toBe(30);
    expect(useTransientEditStore.getState().has('node-1', 'position.x')).toBe(false);
    expect(useTransientEditStore.getState().edits.size).toBe(0);
  });

  it('a sub-frame seconds change (same frame INT) does NOT clear (jitter guard)', () => {
    useTransientEditStore.getState().set('node-1', 'position.x', 9);
    // 0.005s → round(0.3) = frame 0 (unchanged from the starting frame 0).
    useTimeStore.getState().setTime(0.005);
    expect(useTimeStore.getState().frame).toBe(0);
    // The edit must survive — clearing on seconds would wipe it mid-edit (R-4).
    expect(useTransientEditStore.getState().has('node-1', 'position.x')).toBe(true);
  });

  it('a non-frame timeStore change (play/pause) does NOT clear', () => {
    useTransientEditStore.getState().set('node-1', 'position.x', 9);
    useTimeStore.getState().play();
    useTimeStore.getState().pause();
    expect(useTransientEditStore.getState().has('node-1', 'position.x')).toBe(true);
  });
});

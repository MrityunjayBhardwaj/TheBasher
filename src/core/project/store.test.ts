// P6 W3 C1 — projectStore UI projection fields (`dirty` + `lastSavedAt`).
// These are store-only; the persisted Project schema is unchanged.

import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from './store';
import type { Project } from './schema';

function buildSampleProject(updatedAt: number): Project {
  return {
    id: 'p_sample',
    name: 'Sample',
    formatVersion: 1,
    createdAt: updatedAt,
    updatedAt,
    state: { nodes: {}, outputs: {} },
  } as Project;
}

beforeEach(() => {
  // Reset to a clean slate before each case.
  useProjectStore.setState({ current: null, dirty: false, lastSavedAt: null });
});

describe('projectStore — dirty + lastSavedAt (P6 W3)', () => {
  it('starts with dirty=false and lastSavedAt=null', () => {
    const s = useProjectStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.lastSavedAt).toBeNull();
  });

  it('setCurrent(project) resets dirty=false and lastSavedAt=project.updatedAt', () => {
    const t = 1234567;
    useProjectStore.setState({ dirty: true, lastSavedAt: null });
    useProjectStore.getState().setCurrent(buildSampleProject(t));
    const s = useProjectStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.lastSavedAt).toBe(t);
  });

  it('setCurrent(null) clears lastSavedAt and dirty', () => {
    useProjectStore.setState({ dirty: true, lastSavedAt: 999 });
    useProjectStore.getState().setCurrent(null);
    const s = useProjectStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.lastSavedAt).toBeNull();
    expect(s.current).toBeNull();
  });

  it('markDirty() flips dirty=true; idempotent', () => {
    useProjectStore.getState().markDirty();
    expect(useProjectStore.getState().dirty).toBe(true);
    useProjectStore.getState().markDirty();
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('markSaved() flips dirty=false and stamps lastSavedAt near Date.now()', () => {
    useProjectStore.setState({ dirty: true, lastSavedAt: null });
    const before = Date.now();
    useProjectStore.getState().markSaved();
    const after = Date.now();
    const s = useProjectStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.lastSavedAt).not.toBeNull();
    expect(s.lastSavedAt!).toBeGreaterThanOrEqual(before);
    expect(s.lastSavedAt!).toBeLessThanOrEqual(after);
  });
});

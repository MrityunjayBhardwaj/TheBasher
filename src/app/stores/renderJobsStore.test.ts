import { beforeEach, describe, expect, it } from 'vitest';
import { useRenderJobsStore } from './renderJobsStore';

beforeEach(() => {
  // Reset to a fresh empty set between tests — zustand stores persist
  // across test files unless reset.
  useRenderJobsStore.setState({ inFlight: new Set() });
});

describe('renderJobsStore', () => {
  it('starts empty', () => {
    expect(useRenderJobsStore.getState().inFlight.size).toBe(0);
    expect(useRenderJobsStore.getState().isInFlight('any')).toBe(false);
  });

  it('markInFlight returns true on first call, false on second (per-id no-op semantics)', () => {
    const s = useRenderJobsStore.getState();
    expect(s.markInFlight('cw1')).toBe(true);
    expect(s.markInFlight('cw1')).toBe(false);
    // Different ids do not collide.
    expect(s.markInFlight('cw2')).toBe(true);
  });

  it('isInFlight reflects mark/clear', () => {
    const s = useRenderJobsStore.getState();
    s.markInFlight('cw1');
    expect(s.isInFlight('cw1')).toBe(true);
    s.clearInFlight('cw1');
    expect(s.isInFlight('cw1')).toBe(false);
  });

  it('clearInFlight is idempotent', () => {
    const s = useRenderJobsStore.getState();
    s.clearInFlight('never-marked');
    s.markInFlight('cw1');
    s.clearInFlight('cw1');
    s.clearInFlight('cw1');
    expect(s.isInFlight('cw1')).toBe(false);
  });
});

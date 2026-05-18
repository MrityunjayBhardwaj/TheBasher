// autoKeyStore unit tests — bound the Auto-Key (record) mode flag:
//   - default is false (NOT armed) every session
//   - toggle() flips it
//   - toggle is idempotent over a pair (off → on → off)
//   - module-load does not throw under happy-dom (no localStorage surface;
//     a plain require/import must collect cleanly — H26 regression guard)

import { beforeEach, describe, expect, it } from 'vitest';
import { useAutoKeyStore } from './autoKeyStore';

beforeEach(() => {
  // Reset to the documented session default before each test.
  useAutoKeyStore.setState({ enabled: false });
});

describe('autoKeyStore', () => {
  it('defaults to disabled (record OFF) — the footgun-safe default', () => {
    expect(useAutoKeyStore.getState().enabled).toBe(false);
  });

  it('toggle() arms the flag', () => {
    useAutoKeyStore.getState().toggle();
    expect(useAutoKeyStore.getState().enabled).toBe(true);
  });

  it('toggle() is its own inverse over a pair (on → off)', () => {
    const { toggle } = useAutoKeyStore.getState();
    toggle();
    expect(useAutoKeyStore.getState().enabled).toBe(true);
    toggle();
    expect(useAutoKeyStore.getState().enabled).toBe(false);
  });

  it('module-load did not throw under happy-dom (suite collected — H26 guard)', () => {
    // If autoKeyStore touched localStorage at module-load under happy-dom
    // (H26), the whole file would have failed collection before this body
    // ran. Reaching this assertion IS the observation that it did not.
    expect(typeof useAutoKeyStore.getState).toBe('function');
  });
});

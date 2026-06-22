// gizmoStore — transform mode + orientation (#228). The orientation maps to
// three's TransformControls `space`; this verifies the toggle/set semantics.

import { beforeEach, describe, expect, it } from 'vitest';
import { useGizmoStore } from './gizmoStore';

beforeEach(() => {
  useGizmoStore.setState({ dragging: false, mode: 'translate', orientation: 'global' });
});

describe('gizmoStore — orientation (#228 Global/Local)', () => {
  it('defaults to global', () => {
    expect(useGizmoStore.getState().orientation).toBe('global');
  });

  it('toggleOrientation flips global ↔ local', () => {
    useGizmoStore.getState().toggleOrientation();
    expect(useGizmoStore.getState().orientation).toBe('local');
    useGizmoStore.getState().toggleOrientation();
    expect(useGizmoStore.getState().orientation).toBe('global');
  });

  it('setOrientation sets the value directly', () => {
    useGizmoStore.getState().setOrientation('local');
    expect(useGizmoStore.getState().orientation).toBe('local');
  });
});

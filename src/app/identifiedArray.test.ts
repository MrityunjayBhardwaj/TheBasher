import { describe, it, expect } from 'vitest';
import { findById, mintId } from './identifiedArray';

describe('findById', () => {
  it('returns the index of the matching element', () => {
    expect(findById([{ id: 'a' }, { id: 'b' }], 'b')).toBe(1);
  });

  it('returns null (not -1) when no element has the id', () => {
    expect(findById([{ id: 'a' }, { id: 'b' }], 'z')).toBeNull();
  });

  // CONTROL: ids that are NOT what mintId would produce still resolve — so a bug that
  // ignored the id argument and returned a fixed index could not pass here.
  it('resolves arbitrary (non-minted-shaped) ids', () => {
    expect(findById([{ id: 'x9' }, { id: 'zeta' }, { id: 'x9b' }], 'zeta')).toBe(1);
    expect(findById([{ id: 'x9' }, { id: 'zeta' }], 'x9')).toBe(0);
  });
});

describe('mintId', () => {
  it('starts at 0 for an empty set', () => {
    expect(mintId([])).toBe('e0');
    expect(mintId([], 'cp')).toBe('cp0');
  });

  it('returns the first free slot above a contiguous run', () => {
    expect(mintId(['cp0', 'cp1'], 'cp')).toBe('cp2');
  });

  it('fills the lowest hole deterministically', () => {
    expect(mintId(['cp0', 'cp2'], 'cp')).toBe('cp1');
  });

  // Determinism falsify: the same input yields the same output — no module-level counter,
  // no timestamp. If minting kept hidden state, the second call would drift.
  it('is a pure function of its input (deterministic across calls)', () => {
    const taken = ['cp0', 'cp1'];
    expect(mintId(taken, 'cp')).toBe(mintId(taken, 'cp'));
    expect(mintId(taken, 'cp')).toBe('cp2');
  });

  it('accepts a Set as well as an array', () => {
    expect(mintId(new Set(['cp0', 'cp1', 'cp2']), 'cp')).toBe('cp3');
  });
});

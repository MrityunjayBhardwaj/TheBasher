import { describe, expect, it } from 'vitest';
import { hashString, hashValue } from './hash';

describe('hash', () => {
  it('FNV-1a stays stable across calls', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
  });

  it('different strings produce different hashes', () => {
    expect(hashString('hello')).not.toBe(hashString('hellp'));
  });

  it('hashValue ignores object key order', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it('hashValue distinguishes nested differences', () => {
    expect(hashValue({ a: { x: 1 } })).not.toBe(hashValue({ a: { x: 2 } }));
  });

  it('hashValue preserves array order', () => {
    expect(hashValue([1, 2, 3])).not.toBe(hashValue([3, 2, 1]));
  });
});

// Coverage for the asset-error store + formatter (#83 gap 2).
//
// The AssetErrorBoundary class + AssetErrorBanner render path is
// exercised by Playwright (this project has no React Testing Library);
// here we pin the store contract + the thrown-value normaliser, which
// is the logic a regression would most easily break.

import { beforeEach, describe, expect, it } from 'vitest';
import { formatAssetError, useAssetErrorStore } from './assetErrorStore';

beforeEach(() => {
  useAssetErrorStore.setState({ errors: {} });
});

describe('useAssetErrorStore', () => {
  it('report adds an entry keyed by assetRef', () => {
    useAssetErrorStore.getState().report('assets/broken.glb', 'parse error');
    expect(useAssetErrorStore.getState().errors).toEqual({
      'assets/broken.glb': 'parse error',
    });
  });

  it('report replaces (not stacks) the same assetRef', () => {
    const { report } = useAssetErrorStore.getState();
    report('assets/x.glb', 'first reason');
    report('assets/x.glb', 'second reason');
    const errors = useAssetErrorStore.getState().errors;
    expect(Object.keys(errors)).toHaveLength(1);
    expect(errors['assets/x.glb']).toBe('second reason');
  });

  it('report is identity-stable when the same message repeats (no churn)', () => {
    const { report } = useAssetErrorStore.getState();
    report('assets/x.glb', 'same');
    const first = useAssetErrorStore.getState().errors;
    report('assets/x.glb', 'same');
    const second = useAssetErrorStore.getState().errors;
    // Same object identity → React subscribers don't re-render on a
    // repeated identical componentDidCatch.
    expect(second).toBe(first);
  });

  it('tracks multiple distinct assets independently', () => {
    const { report } = useAssetErrorStore.getState();
    report('a.glb', 'reason a');
    report('b.gltf', 'reason b');
    expect(useAssetErrorStore.getState().errors).toEqual({
      'a.glb': 'reason a',
      'b.gltf': 'reason b',
    });
  });

  it('clear removes one asset, leaving the rest', () => {
    const { report, clear } = useAssetErrorStore.getState();
    report('a.glb', 'ra');
    report('b.glb', 'rb');
    clear('a.glb');
    expect(useAssetErrorStore.getState().errors).toEqual({ 'b.glb': 'rb' });
  });

  it('clear is identity-stable when the assetRef is absent', () => {
    useAssetErrorStore.getState().report('a.glb', 'ra');
    const before = useAssetErrorStore.getState().errors;
    useAssetErrorStore.getState().clear('not-present.glb');
    expect(useAssetErrorStore.getState().errors).toBe(before);
  });

  it('clearAll empties the map', () => {
    const { report, clearAll } = useAssetErrorStore.getState();
    report('a.glb', 'ra');
    report('b.glb', 'rb');
    clearAll();
    expect(useAssetErrorStore.getState().errors).toEqual({});
  });
});

describe('formatAssetError', () => {
  it('extracts message from an Error', () => {
    expect(formatAssetError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the Error name when message is empty', () => {
    const e = new Error('');
    e.name = 'TypeError';
    expect(formatAssetError(e)).toBe('TypeError');
  });

  it('passes a thrown string through verbatim', () => {
    expect(formatAssetError('raw failure text')).toBe('raw failure text');
  });

  it('normalises a thrown non-Error to a generic reason', () => {
    expect(formatAssetError({ weird: true })).toBe('Unknown error');
    expect(formatAssetError(null)).toBe('Unknown error');
    expect(formatAssetError(undefined)).toBe('Unknown error');
  });
});

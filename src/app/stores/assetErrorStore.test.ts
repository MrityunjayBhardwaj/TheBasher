// Coverage for the asset-error store + formatter (#83 gap 2).
//
// The AssetErrorBoundary class + AssetErrorBanner render path is
// exercised by Playwright (this project has no React Testing Library);
// here we pin the store contract + the thrown-value normaliser, which
// is the logic a regression would most easily break.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_LABEL, formatAssetError, useAssetErrorStore } from './assetErrorStore';

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

  // #711 — a row's LABEL. The banner said "asset failed:" over every row, including ones the
  // registry classifies as still loading. These rows pin the default (so the existing surface
  // is unchanged), the override, and the two ways a label must not outlive its row.
  it('carries no label by default, so the banner falls back and nothing else moves', () => {
    useAssetErrorStore.getState().report('a.glb', 'boom');
    expect(useAssetErrorStore.getState().labels['a.glb']).toBeUndefined();
    expect(useAssetErrorStore.getState().errors['a.glb']).toBe('boom');
    expect(DEFAULT_ERROR_LABEL).toBe('asset failed:');
  });

  it('carries a label when one is given, without disturbing the message', () => {
    useAssetErrorStore
      .getState()
      .report('modifier:k1', 'cannot load its source', 'modifier blocked:');
    expect(useAssetErrorStore.getState().labels['modifier:k1']).toBe('modifier blocked:');
    expect(useAssetErrorStore.getState().errors['modifier:k1']).toBe('cannot load its source');
  });

  it('a re-report that drops the label DELETES it rather than leaving the old one standing', () => {
    // The failure this catches is a stale label outliving the reason it was right for —
    // a row that stops being "modifier blocked" and keeps saying so.
    const store = () => useAssetErrorStore.getState();
    store().report('r', 'first', 'special:');
    store().report('r', 'second');
    expect(store().labels['r']).toBeUndefined();
    expect('r' in store().labels).toBe(false);
    expect(store().errors['r']).toBe('second');
  });

  it('changing ONLY the label still updates — identity stability must not swallow it', () => {
    // `report` short-circuits on an unchanged message. If the label were left out of that
    // comparison, a row could never change its label without also changing its text.
    const store = () => useAssetErrorStore.getState();
    store().report('r', 'same', 'one:');
    store().report('r', 'same', 'two:');
    expect(store().labels['r']).toBe('two:');
  });

  it('clear and clearAll take the label with the row', () => {
    const store = () => useAssetErrorStore.getState();
    store().report('x', 'm', 'L:');
    store().report('y', 'm2', 'L2:');
    store().clear('x');
    expect(store().labels['x']).toBeUndefined();
    expect(store().labels['y']).toBe('L2:');
    store().clearAll();
    expect(store().labels).toEqual({});
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

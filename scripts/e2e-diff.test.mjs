import { describe, it, expect } from 'vitest';
import { classify, keyFor, parseBaseline } from './e2e-diff.mjs';

// These three tests pin the three properties that make the e2e merge gate
// worth having. Each one corresponds to a way the previous arrangement failed
// (or would have failed), so please don't relax them without reading #463.

describe('classify — the ⊆ predicate', () => {
  const baseline = new Set(['a.spec.ts › one', 'b.spec.ts › two']);

  it('reports a failure that is not in the baseline', () => {
    const { novel } = classify(['a.spec.ts › one', 'c.spec.ts › three'], baseline);
    expect(novel).toEqual(['c.spec.ts › three']);
  });

  it('accepts a run whose failures are a strict SUBSET of the baseline', () => {
    // This is the whole point of ⊆ over ==. An accepted test that flakes GREEN
    // must not red the build. It happens for real: on PR #464 both
    // p7.14-my-imports and spline-projection passed while main had them
    // failing. Under == that is a spurious red every few runs, and a gate that
    // cries wolf gets bypassed — which is exactly the hole #463 closes.
    const { novel, recovered } = classify(['a.spec.ts › one'], baseline);
    expect(novel).toEqual([]);
    expect(recovered).toEqual(['b.spec.ts › two']);
  });

  it('accepts a fully green run', () => {
    const { novel, recovered } = classify([], baseline);
    expect(novel).toEqual([]);
    expect(recovered).toEqual(['a.spec.ts › one', 'b.spec.ts › two']);
  });

  it('separates a baseline entry whose test is gone from one that merely passed', () => {
    // Under ⊆, neither fails the build — but only one of them is actionable
    // from a single run. A test that no longer exists can be pruned right now;
    // a test that passed might just be a flake. Collapsing the two is how a
    // baseline accumulates dead entries and starts growing in one direction.
    const present = new Set(['a.spec.ts › one', 'b.spec.ts › two']);
    const withDeleted = new Set([...baseline, 'deleted.spec.ts › long gone']);
    const { novel, recovered, obsolete } = classify(['a.spec.ts › one'], withDeleted, present);
    expect(novel).toEqual([]);
    expect(recovered).toEqual(['b.spec.ts › two']);
    expect(obsolete).toEqual(['deleted.spec.ts › long gone']);
  });
});

describe('keyFor — identity that survives an edit', () => {
  it('ignores the line number', () => {
    // A branch that edits a spec shifts every line below the edit. Keying on
    // line manufactures phantom "new failures" on precisely the branches we
    // most want to read carefully, so the key must not contain it.
    const atLine10 = keyFor('p151.spec.ts', { title: 'applies a transform', line: 10 });
    const atLine88 = keyFor('p151.spec.ts', { title: 'applies a transform', line: 88 });
    expect(atLine10).toBe(atLine88);
    expect(atLine10).toBe('p151.spec.ts › applies a transform');
  });

  it('keeps same-named tests in different describe blocks distinct', () => {
    const inFoo = keyFor('p26.spec.ts', { title: 'adds a node', path: ['foo'] });
    const inBar = keyFor('p26.spec.ts', { title: 'adds a node', path: ['bar'] });
    expect(inFoo).not.toBe(inBar);
  });

  it('distinguishes the same title in different files', () => {
    expect(keyFor('a.spec.ts', { title: 't' })).not.toBe(keyFor('b.spec.ts', { title: 't' }));
  });
});

describe('parseBaseline', () => {
  it('ignores comments and blank lines so entries can be annotated', () => {
    const parsed = parseBaseline(
      ['# linux-only: software GL', '', 'a.spec.ts › one', '   ', '  b.spec.ts › two  '].join('\n'),
    );
    expect([...parsed].sort()).toEqual(['a.spec.ts › one', 'b.spec.ts › two']);
  });
});

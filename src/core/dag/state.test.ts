// detachGraph — the one definition of "this envelope owns its records" (#620).
//
// The property under test is REACHABILITY, not equality: a detached graph must
// serialise identically to the original (so no export changes bytes) while
// sharing no object with it (so no caller can write through). Asserting only
// deep-equality would pass on the aliasing version that shipped before, which is
// exactly the bug — the alias was deep-equal by construction.

import { describe, expect, it } from 'vitest';
import { detachGraph, emptyDagState, type DagState } from './state';
import type { Node } from './types';

function graphWithOneNode(): DagState {
  const node = {
    id: 'n1',
    type: 'Box',
    version: 1,
    params: { size: [1, 2, 3], name: 'a box' },
    inputs: {},
  } as unknown as Node;
  return { nodes: { n1: node }, outputs: { scene: { node: 'n1' } } };
}

describe('detachGraph (#620)', () => {
  it('shares no object with the graph it copied', () => {
    const original = graphWithOneNode();
    const copy = detachGraph(original);

    expect(copy).not.toBe(original);
    expect(copy.nodes).not.toBe(original.nodes);
    expect(copy.outputs).not.toBe(original.outputs);
    // Down to the records themselves — a table-only copy still lets a caller
    // write through to a node's params, which is how the bug was reachable.
    expect(copy.nodes.n1).not.toBe(original.nodes.n1);
    expect(copy.nodes.n1.params).not.toBe(original.nodes.n1.params);
  });

  it('is value-identical, so nothing downstream serialises differently', () => {
    const original = graphWithOneNode();
    expect(detachGraph(original)).toEqual(original);
    expect(JSON.stringify(detachGraph(original))).toBe(JSON.stringify(original));
  });

  it('a write into the copy does NOT reach the original', () => {
    const original = graphWithOneNode();
    const copy = detachGraph(original);

    delete (copy.nodes as Record<string, unknown>).n1;
    (copy.outputs as Record<string, unknown>).scene = { node: 'gone' };

    expect(original.nodes.n1).toBeDefined();
    expect(original.outputs.scene).toEqual({ node: 'n1' });
  });

  it('a write into a copied node’s params does NOT reach the original', () => {
    const original = graphWithOneNode();
    const copy = detachGraph(original);

    (copy.nodes.n1.params as { size: number[] }).size[0] = 99;

    expect((original.nodes.n1.params as { size: number[] }).size[0]).toBe(1);
  });

  it('handles the empty graph', () => {
    const copy = detachGraph(emptyDagState());
    expect(copy).toEqual({ nodes: {}, outputs: {} });
  });

  it('detaches EVERY field, not just the two it knows by name', () => {
    // The guarantee has to be total, or it is the original bug one level up: an
    // implementation that spread the input and replaced `nodes`/`outputs` by name
    // would pass every other assertion in this file while handing a future
    // DagState field straight through as a live reference. This is the assertion
    // that separates those two implementations.
    const original = { ...graphWithOneNode(), extra: { deep: [1, 2, 3] } };
    const copy = detachGraph(original);

    expect(copy.extra).toEqual({ deep: [1, 2, 3] });
    expect(copy.extra).not.toBe(original.extra);
    copy.extra.deep[0] = 99;
    expect(original.extra.deep[0]).toBe(1);
  });
});

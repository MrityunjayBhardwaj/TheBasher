// sceneHierarchy — and the mirror check the three hand-written copies never had (#621).
//
// The old arrangement was three literal `['children','target']` sweeps, each carrying a
// comment promising it mirrored `childEdges`. Nothing checked the promise, and the
// promise had already been broken in a way nobody noticed: all three matched a MODIFIER's
// `target` too, because they keyed on the socket NAME across every node regardless of
// type, while `childEdges` descends only three value kinds.
//
// `mirrorsChildEdges` below is the check. It drives the real `childEdges` and asserts it
// descends exactly the edges `sceneHierarchy` claims — so a fourth walker, or a drift in
// any one of them, fails here instead of in a wrong world transform months later.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import type { DagState } from '../core/dag/state';
import type { Node } from '../core/dag/types';
import { registerAllNodes } from '../nodes/registerAll';
import { childEdges } from './resolveWorldTransform';
import {
  HIERARCHY_PARENT_TYPES,
  hasHierarchyParent,
  hierarchyChildIds,
  hierarchySocketForKind,
  hierarchySocketsOf,
} from './sceneHierarchy';

function node(id: string, type: string, inputs: Record<string, unknown> = {}): Node {
  return { id, type, params: {}, inputs } as unknown as Node;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerAllNodes();
});

describe('hierarchySocketsOf', () => {
  it('gives a wrapper its DECLARED chain socket, not the name `target`', () => {
    expect(hierarchySocketsOf(node('a', 'Transform'))).toEqual(['target']);
    expect(hierarchySocketsOf(node('a', 'MaterialOverride'))).toEqual(['target']);
  });

  it('gives an aggregate its children list socket', () => {
    expect(hierarchySocketsOf(node('a', 'Group'))).toEqual(['children']);
    expect(hierarchySocketsOf(node('a', 'Scene'))).toEqual(['children']);
  });

  it('gives an OPERATOR nothing, even though it declares a `target` chain socket', () => {
    // The distinction #621 exists to draw. These all declare `chainInput: 'target'` and
    // are all walked past by the scene-graph question — a modifier consumes a mesh and
    // emits a reshaped one; it does not PARENT it.
    for (const t of [
      'ArrayModifier',
      'MirrorModifier',
      'SetMaterialOp',
      'MaterialOverrideOp',
      'ColorCorrect',
    ]) {
      expect(hierarchySocketsOf(node('a', t)), `${t} must not parent`).toEqual([]);
    }
  });

  it('gives a leaf producer nothing', () => {
    expect(hierarchySocketsOf(node('a', 'BoxData'))).toEqual([]);
    expect(hierarchySocketsOf(undefined)).toEqual([]);
  });
});

describe('hierarchyChildIds / hasHierarchyParent', () => {
  it('reads a wrapper through its spine and an aggregate through its list', () => {
    expect(hierarchyChildIds(node('t', 'Transform', { target: { node: 'kid' } }))).toEqual(['kid']);
    expect(
      hierarchyChildIds(node('g', 'Group', { children: [{ node: 'a' }, { node: 'b' }] })),
    ).toEqual(['a', 'b']);
  });

  it('does NOT count a mesh wired into a modifier as a child — the #621 narrowing', () => {
    const arr = node('arr', 'ArrayModifier', { target: { node: 'mesh' } });
    expect(hierarchyChildIds(arr)).toEqual([]);
    expect(hasHierarchyParent([arr], 'mesh')).toBe(false);
    // ...while the same mesh under a Transform IS nested.
    const xf = node('xf', 'Transform', { target: { node: 'mesh' } });
    expect(hasHierarchyParent([arr, xf], 'mesh')).toBe(true);
  });

  it('ignores an unbound socket and a malformed ref', () => {
    expect(hierarchyChildIds(node('t', 'Transform', {}))).toEqual([]);
    expect(hierarchyChildIds(node('t', 'Transform', { target: null }))).toEqual([]);
    expect(hierarchyChildIds(node('g', 'Group', { children: [{}, { node: 'ok' }] }))).toEqual([
      'ok',
    ]);
  });
});

describe('mirrorsChildEdges — the promise three comments used to make', () => {
  /** Drive the REAL childEdges for a parent type and report which child ids it descended. */
  function descended(type: string, inputs: Record<string, unknown>, value: unknown): string[] {
    const state = {
      nodes: { p: node('p', type, inputs), a: node('a', 'BoxData'), b: node('b', 'BoxData') },
    } as unknown as DagState;
    return childEdges(state, 'p', value as never).map((e) => e.id);
  }

  it('descends exactly the edges sceneHierarchy names, for every wrapper type', () => {
    for (const type of ['Transform', 'MaterialOverride']) {
      const inputs = { target: { node: 'a' } };
      const claimed = hierarchyChildIds(node('p', type, inputs));
      const actual = descended(type, inputs, { kind: type, child: { kind: 'Mesh' } });
      expect(actual, `${type}: childEdges and sceneHierarchy disagree`).toEqual(claimed);
    }
  });

  it('descends exactly the edges sceneHierarchy names, for the aggregate type', () => {
    const inputs = { children: [{ node: 'a' }, { node: 'b' }] };
    const claimed = hierarchyChildIds(node('p', 'Group', inputs));
    const actual = descended('Group', inputs, {
      kind: 'Group',
      children: [{ kind: 'Mesh' }, { kind: 'Mesh' }],
    });
    expect(actual).toEqual(claimed);
  });

  it('descends nothing for a type sceneHierarchy says is not a parent', () => {
    // Even handed a value whose kind LOOKS like a wrapper — the node's type is what
    // decides, and an operator is not a parent.
    const inputs = { target: { node: 'a' } };
    expect(hierarchyChildIds(node('p', 'ArrayModifier', inputs))).toEqual([]);
    expect(descended('ArrayModifier', inputs, { kind: 'Mesh' })).toEqual([]);
  });

  it('follows the DECLARATION when a node presents a wrapper kind under another type', () => {
    // The case that caught a real over-narrowing while #621 was being written. An earlier
    // draft keyed childEdges on the node TYPE, which collapsed the two accessors into one
    // and quietly dropped this: a node whose evaluated value says `kind: 'Transform'` but
    // whose type is something else stopped being descended. Production never sees it —
    // type === kind for all three shipped parents — so only a fixture can hold the line,
    // and holding it is the entire content of #396/#610.
    expect(hierarchySocketForKind('Transform', node('p', 'SomeOtherWrapper'))).toBe(null);
    // ...null there only because that fixture type is unregistered and so declares no
    // spine. A registered type that DOES declare one is followed by its declaration:
    expect(hierarchySocketForKind('Transform', node('p', 'MaterialOverride'))).toBe('target');
    // The type-keyed accessor is deliberately narrower — it has no value to read a kind
    // from, so an unrecognised type is simply not a parent.
    expect(hierarchySocketsOf(node('p', 'SomeOtherWrapper'))).toEqual([]);
  });

  it('every parent type produces at least one socket — no silently dead member', () => {
    // Guard the guard: a type listed as a parent whose socket resolves to nothing would
    // make every assertion above vacuous for that member.
    expect(HIERARCHY_PARENT_TYPES.size).toBeGreaterThanOrEqual(4);
    for (const t of HIERARCHY_PARENT_TYPES) {
      expect(hierarchySocketsOf(node('x', t)), `${t} resolved to no socket`).not.toEqual([]);
    }
  });
});

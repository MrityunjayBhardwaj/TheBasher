// Closure expansion unit tests.
//
// Per P2.5.2 PLAN §5 Wave A: BFS scope, cycle safety, maxDepth,
// determinism. Plus the helper-level checks: opTargetNodeId for every
// op variant + isFreshAddNode against a real DagState.
//
// REF: vyapti V13 (closure preservation, NOT YET IMPLEMENTED until Wave A
// lands). These tests are part of what flips it to ALIGNED.

import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRegistryForTests, applyOp, emptyDagState, type DagState } from '../../core/dag';
import { __reseedAllNodesForTests } from '../../nodes/registerAll';
import { expandClosure, isFreshAddNode, opTargetNodeId } from './expand';
import type { ClosureSpec } from './types';
import type { Op } from '../../core/dag/types';

beforeEach(() => {
  __resetRegistryForTests();
  __reseedAllNodesForTests();
});

function buildBaseline(): DagState {
  // scene.children = [box, sphere];  scene.out → render.scene
  let s = emptyDagState();
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'sphere',
    nodeType: 'SphereMesh',
    params: { radius: 1, position: [2, 0, 0] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'render',
    nodeType: 'RenderOutput',
    params: { postFx: { tonemap: 'ACES', smaa: true } },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'sphere', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'scene', socket: 'out' },
    to: { node: 'render', socket: 'scene' },
  }).next;
  return s;
}

describe('expandClosure', () => {
  it('single root, no edges → only the root', () => {
    const state = buildBaseline();
    const closure = expandClosure({ rootSelectors: ['box'], followedEdges: [] }, state);
    expect([...closure.nodes]).toEqual(['box']);
    expect(closure.edges).toHaveLength(0);
  });

  it("'parent' edge walks consumer side (box → scene → render)", () => {
    const state = buildBaseline();
    const closure = expandClosure(
      { rootSelectors: ['box'], followedEdges: ['parent'] },
      state,
    );
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('scene')).toBe(true);
    expect(closure.nodes.has('render')).toBe(true);
    // Sibling sphere is not on the parent chain — must NOT be reached.
    expect(closure.nodes.has('sphere')).toBe(false);
  });

  it("'children' edge walks producer side (scene → box, sphere)", () => {
    const state = buildBaseline();
    const closure = expandClosure(
      { rootSelectors: ['scene'], followedEdges: ['children'] },
      state,
    );
    expect(closure.nodes.has('scene')).toBe(true);
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('sphere')).toBe(true);
    expect(closure.nodes.has('render')).toBe(false);
  });

  it("['parent','children'] from a leaf does NOT reach a sibling (no free direction-mixing)", () => {
    const state = buildBaseline();
    const closure = expandClosure(
      { rootSelectors: ['box'], followedEdges: ['parent', 'children'] },
      state,
    );
    // Each edge kind runs its own per-root BFS. parent: box → scene →
    // render. children: box has no inputs → empty. Sibling is reachable
    // only by parent ∘ children, which the gate refuses to do — that's
    // the V13 acceptance #2 guarantee ("rotate selected can NEVER produce
    // ops that mutate any other node").
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('scene')).toBe(true);
    expect(closure.nodes.has('render')).toBe(true);
    expect(closure.nodes.has('sphere')).toBe(false);
  });

  it('unknown root id is skipped (no throw, no expansion from it)', () => {
    const state = buildBaseline();
    const closure = expandClosure(
      { rootSelectors: ['nonexistent', 'box'], followedEdges: ['parent'] },
      state,
    );
    expect(closure.nodes.has('nonexistent')).toBe(false);
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('scene')).toBe(true);
  });

  it('cycle-safe: visited set bounds traversal on a manually-cyclic graph', () => {
    // applyOp rejects cycles, so we build a cyclic DagState by hand. The
    // gate lives one layer above the Op validator and must terminate even
    // if a future evaluator allows reference cycles.
    const cyclic: DagState = {
      nodes: {
        a: {
          id: 'a',
          type: 'TestNode',
          version: 1,
          params: {},
          inputs: { in: { node: 'b', socket: 'out' } },
        },
        b: {
          id: 'b',
          type: 'TestNode',
          version: 1,
          params: {},
          inputs: { in: { node: 'a', socket: 'out' } },
        },
      },
      outputs: {},
    };
    const closure = expandClosure(
      { rootSelectors: ['a'], followedEdges: ['parent', 'children'] },
      cyclic,
    );
    // Both nodes reached, traversal terminated.
    expect(closure.nodes.has('a')).toBe(true);
    expect(closure.nodes.has('b')).toBe(true);
  });

  it('maxDepth caps traversal', () => {
    // Build a chain a → b → c → d (consumer side: d.in = c, c.in = b, b.in = a)
    const chain: DagState = {
      nodes: {
        a: { id: 'a', type: 'T', version: 1, params: {}, inputs: {} },
        b: { id: 'b', type: 'T', version: 1, params: {}, inputs: { in: { node: 'a', socket: 'o' } } },
        c: { id: 'c', type: 'T', version: 1, params: {}, inputs: { in: { node: 'b', socket: 'o' } } },
        d: { id: 'd', type: 'T', version: 1, params: {}, inputs: { in: { node: 'c', socket: 'o' } } },
      },
      outputs: {},
    };
    const shallow = expandClosure(
      { rootSelectors: ['a'], followedEdges: ['parent'], maxDepth: 1 },
      chain,
    );
    // From a (depth 0): visit b (depth 1). At depth 1 we don't recurse
    // further because depth >= maxDepth.
    expect(shallow.nodes.has('a')).toBe(true);
    expect(shallow.nodes.has('b')).toBe(true);
    expect(shallow.nodes.has('c')).toBe(false);
    expect(shallow.nodes.has('d')).toBe(false);
  });

  it('deterministic: same (spec, state) → same nodes + edges', () => {
    const state = buildBaseline();
    const spec: ClosureSpec = {
      rootSelectors: ['box'],
      followedEdges: ['parent', 'children'],
    };
    const a = expandClosure(spec, state);
    const b = expandClosure(spec, state);
    expect([...a.nodes]).toEqual([...b.nodes]);
    expect(a.edges).toEqual(b.edges);
  });

  it('socket-named edge kind walks only matching sockets', () => {
    const state = buildBaseline();
    // 'children' as a socket name (Scene.inputs.children = [box, sphere])
    const closure = expandClosure(
      { rootSelectors: ['scene'], followedEdges: ['children'] },
      state,
    );
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('sphere')).toBe(true);
    // 'time' would not match any socket on Scene → no expansion.
    const timeOnly = expandClosure(
      { rootSelectors: ['scene'], followedEdges: ['time'] },
      state,
    );
    expect([...timeOnly.nodes]).toEqual(['scene']);
  });
});

describe('opTargetNodeId', () => {
  it('addNode → nodeId', () => {
    const op: Op = {
      type: 'addNode',
      nodeId: 'newBox',
      nodeType: 'BoxMesh',
      params: {},
    };
    expect(opTargetNodeId(op)).toBe('newBox');
  });

  it('removeNode → nodeId', () => {
    expect(opTargetNodeId({ type: 'removeNode', nodeId: 'box' })).toBe('box');
  });

  it('setParam → nodeId', () => {
    expect(
      opTargetNodeId({
        type: 'setParam',
        nodeId: 'box',
        paramPath: 'rotation',
        value: [45, 0, 0],
      }),
    ).toBe('box');
  });

  it('connect → to.node (the consumer whose inputs change)', () => {
    expect(
      opTargetNodeId({
        type: 'connect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      }),
    ).toBe('scene');
  });

  it('disconnect → to.node', () => {
    expect(
      opTargetNodeId({
        type: 'disconnect',
        from: { node: 'box', socket: 'out' },
        to: { node: 'scene', socket: 'children' },
      }),
    ).toBe('scene');
  });
});

describe('isFreshAddNode', () => {
  it('true when addNode introduces an id not in priorState', () => {
    const state = buildBaseline();
    const op: Op = {
      type: 'addNode',
      nodeId: 'fresh',
      nodeType: 'BoxMesh',
      params: {},
    };
    expect(isFreshAddNode(op, state)).toBe(true);
  });

  it('false when addNode re-uses an existing id', () => {
    const state = buildBaseline();
    const op: Op = {
      type: 'addNode',
      nodeId: 'box',
      nodeType: 'BoxMesh',
      params: {},
    };
    expect(isFreshAddNode(op, state)).toBe(false);
  });

  it('false for non-addNode ops', () => {
    const state = buildBaseline();
    expect(
      isFreshAddNode(
        { type: 'setParam', nodeId: 'box', paramPath: 'x', value: 1 },
        state,
      ),
    ).toBe(false);
  });
});

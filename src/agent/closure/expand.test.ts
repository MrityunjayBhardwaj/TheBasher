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
    const closure = expandClosure({ rootSelectors: ['box'], followedEdges: ['parent'] }, state);
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('scene')).toBe(true);
    expect(closure.nodes.has('render')).toBe(true);
    // Sibling sphere is not on the parent chain — must NOT be reached.
    expect(closure.nodes.has('sphere')).toBe(false);
  });

  it("'children' edge walks producer side (scene → box, sphere)", () => {
    const state = buildBaseline();
    const closure = expandClosure({ rootSelectors: ['scene'], followedEdges: ['children'] }, state);
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
        b: {
          id: 'b',
          type: 'T',
          version: 1,
          params: {},
          inputs: { in: { node: 'a', socket: 'o' } },
        },
        c: {
          id: 'c',
          type: 'T',
          version: 1,
          params: {},
          inputs: { in: { node: 'b', socket: 'o' } },
        },
        d: {
          id: 'd',
          type: 'T',
          version: 1,
          params: {},
          inputs: { in: { node: 'c', socket: 'o' } },
        },
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
    const closure = expandClosure({ rootSelectors: ['scene'], followedEdges: ['children'] }, state);
    expect(closure.nodes.has('box')).toBe(true);
    expect(closure.nodes.has('sphere')).toBe(true);
    // 'time' would not match any socket on Scene → no expansion.
    const timeOnly = expandClosure({ rootSelectors: ['scene'], followedEdges: ['time'] }, state);
    expect([...timeOnly.nodes]).toEqual(['scene']);
  });

  // #20: a consumer that binds the same producer through two sockets
  // (think a Texture wired to both `albedo` and `normal` on a Material)
  // used to emit one ClosureEdge per socket. The closure node-set was
  // still correct, but `edges` carried redundant (from, to, kind)
  // entries — wasted space + double-processing for any consumer that
  // iterates edges.
  it("'parent' dedupes when one consumer references the same producer via multiple sockets (#20)", () => {
    const state: DagState = {
      nodes: {
        tex: { id: 'tex', type: 'Texture', version: 1, params: {}, inputs: {} },
        material: {
          id: 'material',
          type: 'Material',
          version: 1,
          params: {},
          inputs: {
            albedo: { node: 'tex', socket: 'out' },
            normal: { node: 'tex', socket: 'out' },
          },
        },
      },
      outputs: {},
    };
    const closure = expandClosure({ rootSelectors: ['tex'], followedEdges: ['parent'] }, state);
    expect(closure.nodes.has('material')).toBe(true);
    const dupes = closure.edges.filter(
      (e) => e.from === 'tex' && e.to === 'material' && e.kind === 'parent',
    );
    expect(dupes).toHaveLength(1);
  });

  it("'children' dedupes when a node binds to the same producer via multiple sockets (#20)", () => {
    const state: DagState = {
      nodes: {
        tex: { id: 'tex', type: 'Texture', version: 1, params: {}, inputs: {} },
        material: {
          id: 'material',
          type: 'Material',
          version: 1,
          params: {},
          inputs: {
            albedo: { node: 'tex', socket: 'out' },
            normal: { node: 'tex', socket: 'out' },
          },
        },
      },
      outputs: {},
    };
    const closure = expandClosure(
      { rootSelectors: ['material'], followedEdges: ['children'] },
      state,
    );
    expect(closure.nodes.has('tex')).toBe(true);
    const dupes = closure.edges.filter(
      (e) => e.from === 'material' && e.to === 'tex' && e.kind === 'children',
    );
    expect(dupes).toHaveLength(1);
  });

  it('distinct (from, to, kind) edges are still preserved when multiple consumers point to one producer (#20)', () => {
    // Two materials both bind the same texture. `edges` from 'parent'
    // walk must keep BOTH {tex→matA} and {tex→matB} — they are
    // semantically distinct paths to the same node.
    const state: DagState = {
      nodes: {
        tex: { id: 'tex', type: 'Texture', version: 1, params: {}, inputs: {} },
        matA: {
          id: 'matA',
          type: 'Material',
          version: 1,
          params: {},
          inputs: { albedo: { node: 'tex', socket: 'out' } },
        },
        matB: {
          id: 'matB',
          type: 'Material',
          version: 1,
          params: {},
          inputs: { albedo: { node: 'tex', socket: 'out' } },
        },
      },
      outputs: {},
    };
    const closure = expandClosure({ rootSelectors: ['tex'], followedEdges: ['parent'] }, state);
    expect(closure.edges).toEqual([
      { from: 'tex', to: 'matA', kind: 'parent' },
      { from: 'tex', to: 'matB', kind: 'parent' },
    ]);
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
      isFreshAddNode({ type: 'setParam', nodeId: 'box', paramPath: 'x', value: 1 }, state),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3 — 'animation' edge kind (H22 risk surface)
//
// 'animation' is a socket-named edge kind. AnimationLayer is the first node
// type to carry an `animation` input socket. The per-kind BFS isolation rule
// (one BFS per declared kind, rooted at rootSelectors only) must hold once a
// real socket exists at that name — otherwise sibling channels could leak
// into a closure rooted on one layer.
// ---------------------------------------------------------------------------

function buildAnimationBaseline(): DagState {
  // Two AnimationLayers (layerA / layerB), each fed by its own
  // KeyframeChannel (chA / chB) plus a shared TimeSource. layerA wraps boxA;
  // layerB wraps boxB. Closure rooted at layerA via 'animation' must reach
  // chA only — chB is a sibling under no shared parent, but could leak if
  // the walker re-rooted via the visited set across kinds.
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'chA',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'A',
      target: 'boxA',
      paramPath: 'foo',
      keyframes: [{ time: 0, value: 0, easing: 'linear' }],
    },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'chB',
    nodeType: 'KeyframeChannelNumber',
    params: {
      name: 'B',
      target: 'boxB',
      paramPath: 'foo',
      keyframes: [{ time: 0, value: 0, easing: 'linear' }],
    },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'chA', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'time', socket: 'out' },
    to: { node: 'chB', socket: 'time' },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'boxA',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'boxB',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'layerA',
    nodeType: 'AnimationLayer',
    params: {},
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'layerB',
    nodeType: 'AnimationLayer',
    params: {},
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'boxA', socket: 'out' },
    to: { node: 'layerA', socket: 'target' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'chA', socket: 'out' },
    to: { node: 'layerA', socket: 'animation' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'boxB', socket: 'out' },
    to: { node: 'layerB', socket: 'target' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'chB', socket: 'out' },
    to: { node: 'layerB', socket: 'animation' },
  }).next;
  return s;
}

describe("P3 — 'animation' edge kind (H22 isolation under real socket)", () => {
  it("'animation' from layerA reaches its own channel, NOT the sibling layer's", () => {
    const state = buildAnimationBaseline();
    const closure = expandClosure(
      { rootSelectors: ['layerA'], followedEdges: ['animation'] },
      state,
    );
    expect(closure.nodes.has('layerA')).toBe(true);
    expect(closure.nodes.has('chA')).toBe(true);
    // The other layer's channel is a sibling — must NOT leak.
    expect(closure.nodes.has('chB')).toBe(false);
    expect(closure.nodes.has('layerB')).toBe(false);
  });

  it("['parent','animation'] from chA reaches layerA but does NOT free-mix into siblings", () => {
    const state = buildAnimationBaseline();
    const closure = expandClosure(
      { rootSelectors: ['chA'], followedEdges: ['parent', 'animation'] },
      state,
    );
    // 'parent' walk from chA reaches layerA (its consumer).
    expect(closure.nodes.has('chA')).toBe(true);
    expect(closure.nodes.has('layerA')).toBe(true);
    // chB sits at the same depth under layerB; if 'animation' BFS were seeded
    // from visited (instead of rootSelectors), the walker would re-root at
    // layerA after 'parent' added it, then walk to chA again — fine. But
    // there must be NO path that picks up layerB or chB from this set of
    // declared kinds + roots.
    expect(closure.nodes.has('chB')).toBe(false);
    expect(closure.nodes.has('layerB')).toBe(false);
  });

  it("'animation' BFS at layerA does not carry over to 'children' edges (no kind-mixing)", () => {
    const state = buildAnimationBaseline();
    const closure = expandClosure(
      { rootSelectors: ['layerA'], followedEdges: ['animation'] },
      state,
    );
    // boxA is reachable from layerA only via the 'target' socket — that's a
    // 'children' walk, not 'animation'. With only 'animation' declared, boxA
    // must NOT be in the closure.
    expect(closure.nodes.has('boxA')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 — 'pass-input' edge kind (forward-declared, no live socket in Wave A)
//
// 'pass-input' is the new socket-named edge kind P4 makes concrete. In Wave
// A no node carries a `pass-input` input socket — RenderJob lands in Wave
// B. The walker must treat 'pass-input' as a no-match fall-through so the
// kind can sit in EdgeKind without breaking existing closures. The full
// H22 isolation test (sibling pass leakage) lands in Wave B alongside the
// live socket.
//
// Detection signal: a closure rooted at a BeautyPass/IDPass node with
// followedEdges=['pass-input'] must contain only the root — pass nodes do
// NOT consume passes. They produce them.
// ---------------------------------------------------------------------------

function buildPassBaseline(): DagState {
  // BeautyPass + IDPass each fed by Time + Camera + Scene. No node has a
  // 'pass-input' socket — that arrives with RenderJob in Wave B.
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'beauty', nodeType: 'BeautyPass', params: {} }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'idp', nodeType: 'IDPass', params: {} }).next;
  for (const passId of ['beauty', 'idp']) {
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: passId, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: passId, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: passId, socket: 'time' },
    }).next;
  }
  return s;
}

describe("P4 — 'pass-input' edge kind (Wave A — forward-declared, no live socket)", () => {
  it("'pass-input' from a pass root falls through cleanly (no consumers, no leaks)", () => {
    const state = buildPassBaseline();
    const closure = expandClosure(
      { rootSelectors: ['beauty'], followedEdges: ['pass-input'] },
      state,
    );
    // beauty itself is in the closure (every reachable root is seeded).
    expect(closure.nodes.has('beauty')).toBe(true);
    // No node consumes 'pass-input' yet, so the walk terminates immediately.
    expect(closure.nodes.size).toBe(1);
    expect(closure.edges).toEqual([]);
    // Sibling pass MUST NOT leak through any kind-mixing.
    expect(closure.nodes.has('idp')).toBe(false);
  });

  it("['parent','pass-input'] from beauty does NOT reach the sibling IDPass", () => {
    const state = buildPassBaseline();
    const closure = expandClosure(
      { rootSelectors: ['beauty'], followedEdges: ['parent', 'pass-input'] },
      state,
    );
    expect(closure.nodes.has('beauty')).toBe(true);
    // 'parent' walk from beauty has no consumers either (passes are sinks
    // until RenderJob lands). 'pass-input' has no producers. Closure stays
    // single-node — H22's per-kind BFS isolation rule holds for the new
    // edge kind even with mixed kinds declared.
    expect(closure.nodes.has('idp')).toBe(false);
    expect(closure.nodes.has('scene')).toBe(false);
  });

  it("'children' walk from a pass reaches its inputs but skips 'pass-input' kind", () => {
    const state = buildPassBaseline();
    // 'children' walks every input socket regardless of name — so scene,
    // camera, time all show up. This proves 'pass-input' isn't being
    // confused for 'children'; the kinds are independent.
    const closure = expandClosure(
      { rootSelectors: ['beauty'], followedEdges: ['children'] },
      state,
    );
    expect(closure.nodes.has('scene')).toBe(true);
    expect(closure.nodes.has('cam')).toBe(true);
    expect(closure.nodes.has('time')).toBe(true);
    // sibling pass still must not leak.
    expect(closure.nodes.has('idp')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 — 'pass-input' edge kind (Wave B — live socket via RenderJob)
//
// RenderJob is the first node carrying a 'pass-input' input socket. With
// two jobs each owning its own pass, a closure rooted at jobA via
// 'pass-input' must reach passA only — passB is a sibling under no shared
// parent, but would leak if the per-kind BFS isolation rule (H22) were
// violated. Sister test to the 'animation' isolation tests above.
// ---------------------------------------------------------------------------

function buildTwoJobsState(): DagState {
  let s = emptyDagState();
  s = applyOp(s, { type: 'addNode', nodeId: 'time', nodeType: 'TimeSource', params: {} }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'cam',
    nodeType: 'PerspectiveCamera',
    params: { fov: 45, position: [0, 0, 5] },
  }).next;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'box',
    nodeType: 'BoxMesh',
    params: { size: [1, 1, 1] },
  }).next;
  s = applyOp(s, { type: 'addNode', nodeId: 'scene', nodeType: 'Scene', params: {} }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'cam', socket: 'out' },
    to: { node: 'scene', socket: 'camera' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'box', socket: 'out' },
    to: { node: 'scene', socket: 'children' },
  }).next;
  for (const passId of ['passA', 'passB']) {
    s = applyOp(s, { type: 'addNode', nodeId: passId, nodeType: 'BeautyPass', params: {} }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'scene', socket: 'out' },
      to: { node: passId, socket: 'scene' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'cam', socket: 'out' },
      to: { node: passId, socket: 'camera' },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: passId, socket: 'time' },
    }).next;
  }
  for (const jobId of ['jobA', 'jobB']) {
    s = applyOp(s, {
      type: 'addNode',
      nodeId: jobId,
      nodeType: 'RenderJob',
      params: { jobId },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'time', socket: 'out' },
      to: { node: jobId, socket: 'time' },
    }).next;
  }
  // jobA owns passA; jobB owns passB.
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'passA', socket: 'out' },
    to: { node: 'jobA', socket: 'pass-input' },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: 'passB', socket: 'out' },
    to: { node: 'jobB', socket: 'pass-input' },
  }).next;
  return s;
}

describe("P4 — 'pass-input' edge kind (Wave B — H22 live-socket isolation)", () => {
  it("'pass-input' from jobA reaches passA, NOT the sibling job's pass", () => {
    const state = buildTwoJobsState();
    const closure = expandClosure(
      { rootSelectors: ['jobA'], followedEdges: ['pass-input'] },
      state,
    );
    expect(closure.nodes.has('jobA')).toBe(true);
    expect(closure.nodes.has('passA')).toBe(true);
    // The sibling job's pass MUST NOT leak — H22.
    expect(closure.nodes.has('passB')).toBe(false);
    expect(closure.nodes.has('jobB')).toBe(false);
  });

  it("['parent','pass-input'] from passA reaches jobA but does NOT free-mix", () => {
    const state = buildTwoJobsState();
    const closure = expandClosure(
      { rootSelectors: ['passA'], followedEdges: ['parent', 'pass-input'] },
      state,
    );
    expect(closure.nodes.has('passA')).toBe(true);
    expect(closure.nodes.has('jobA')).toBe(true);
    // sibling pass + sibling job MUST NOT leak.
    expect(closure.nodes.has('passB')).toBe(false);
    expect(closure.nodes.has('jobB')).toBe(false);
  });

  it("'pass-input' BFS at jobA does not carry over to other input-socket walks", () => {
    const state = buildTwoJobsState();
    const closure = expandClosure(
      { rootSelectors: ['jobA'], followedEdges: ['pass-input'] },
      state,
    );
    // jobA also has a 'time' input. With only 'pass-input' declared, the
    // time producer must NOT be reached — kinds are independent.
    expect(closure.nodes.has('time')).toBe(false);
    // And of course neither sibling's pass nor scene/camera through some
    // other path.
    expect(closure.nodes.has('scene')).toBe(false);
  });
});

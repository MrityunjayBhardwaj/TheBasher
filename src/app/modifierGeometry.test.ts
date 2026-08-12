// modifierGeometry — the ONE kind-dispatch for "can this be modified, and with what?"
// (#377, epic #365 Stage B; moved onto the data lane by #415). The cases below pin the
// two things that were broken on `main` and the one structural guard that keeps them
// from breaking again:
//
//   1. THE BOUNDARY PAIR. A modifier on a split cube resolved as a real array on the
//      READ road (`resolveEvaluatedMesh` gained an `Object` branch in #362) and passed
//      THROUGH unchanged on the RENDER road (`evaluate`, which never did). Read and
//      render disagreed with nothing to catch it. The pair is asserted directly:
//      the two roads must produce the SAME geometry key (H40, one band).
//   2. THE OFFER. `canModifyGeometry` is the predicate the UI gates on, and it is the
//      predicate `evaluate` accepts — V108. A cube must be offered modifiers.
//   3. THE `never` GATE. `modifierDataSource` has no `default:` arm, so a new
//      `ObjectData` kind fails to compile until its answer is declared (V109). Stage C
//      put five data kinds behind `Object` and #415 added a sixth; this is what stops
//      each one being a silent passthrough. Verified by falsification, noted at the bottom.
//
// #415 — THE ATTACHMENT MOVED, AND TWO CASES HERE INVERTED RATHER THAN MOVED.
// The stack now splices between the mesh data and the Object (`BoxData → Array →
// Object`) instead of downstream of the Object. So:
//   - "inherits the OBJECT's pose" is now FALSE OF THE MODIFIER and true only at the
//     render seam. `ModifiedData` carries no TRS at all; the Object applies it once,
//     above the whole stack. The case is rewritten to assert the absence AND that the
//     Object still poses the result — asserting only the second half would pass on a
//     modifier that had wrongly kept a pose of its own.
//   - "a modifier passes an unmodifiable source through" can no longer use a Group.
//     A Group emits `SceneObject` and the modifier's `target` takes `ObjectData`, so
//     that wiring is now REFUSED BY THE CONNECT CHECK — the type system says what the
//     #256 banner used to explain in prose. The surviving passthrough case is non-mesh
//     DATA (a curve), which wires fine and is correctly left alone.
//
// REF: src/app/modifierGeometry.ts; src/app/resolveEvaluatedMesh.ts;
//      src/nodes/ArrayModifier.ts; src/app/operatorStack.ts; issue #415.

import { describe, it, expect, beforeEach } from 'vitest';
import { emptyDagState, applyOp, type DagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { rowDataParams, splitOps } from '../test-utils/splitKinds';
import {
  boxDescriptor,
  boxGeometryRef,
  canModifyGeometry,
  modifierDataSource,
  resolveDataKind,
} from './modifierGeometry';
import { mintMeshAttributes } from '../nodes/meshAttributes';
import { buildDefaultDagState } from '../core/project/default';
import { buildAddModifierOps, resolveStackBase } from './operatorStack';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import type { ObjectData } from '../nodes/types';

/** A split cube with an ArrayModifier spliced onto its DATA lane. Returns the ids.
 *  Built through the production builder, so the topology here is whatever the panel
 *  actually produces rather than a second description of it. */
function splitCubeWithArray(opts: { position?: [number, number, number]; color?: string } = {}) {
  const seeded = makeSplitCube(emptyDagState(), {
    objectId: 'n_box',
    size: [1, 1, 1],
    position: opts.position,
    color: opts.color,
  });
  const res = buildAddModifierOps(
    seeded.state,
    resolveStackBase(seeded.state, seeded.objectId),
    'ArrayModifier',
    { count: 4, offset: [2, 0, 0] },
    'n_arr',
  );
  if (!res) throw new Error('buildAddModifierOps returned null for a split cube');
  const s: DagState = res.ops.reduce((acc, op) => applyOp(acc, op).next, seeded.state);
  return { state: s, objectId: seeded.objectId, dataId: seeded.dataId, modifierId: 'n_arr' };
}

describe('modifierGeometry — a modifier attaches to the Object and reshapes its data (#377)', () => {
  beforeEach(() => __reseedAllNodesForTests());

  it('read and render agree on a split-Object source (the pair that was broken)', () => {
    const { state, modifierId } = splitCubeWithArray();

    const rendered = evaluate(state, modifierId).value as ObjectData;
    const read = resolveEvaluatedMesh(state, modifierId);

    // Before the fix the render road returned the source VERBATIM (geometry
    // 'box|1,1,1') while the read road returned the array.
    //
    // #638 — the source box's key now carries an attribute component, and an `array` key
    // embeds its source's key verbatim, so the component rides along. The modifier itself
    // gains no assignment (D6 — a merged geometry's faces are not the source's faces), and
    // the `array` builder still takes no attribute key of its own; this is the SOURCE's
    // identity showing through, which is what an `array` key is made of.
    expect(rendered.kind).toBe('ModifiedData');
    expect(read).not.toBeNull();
    const sourceKey = boxGeometryRef(
      [1, 1, 1],
      mintMeshAttributes(boxDescriptor([1, 1, 1]), 'evaluate'),
    ).key;
    expect((rendered as { geometry: { key: string } }).geometry.key).toBe(
      `array|${sourceKey}|4|2,0,0`,
    );
    // The one band: both roads build the identical deterministic key.
    expect((rendered as { geometry: { key: string } }).geometry.key).toBe(read!.geometry.key);
  });

  // #415 — INVERTED. This case used to assert the modifier INHERITED the Object's pose,
  // which was true while the modifier sat downstream of it. On the data lane the pose is
  // applied ABOVE the stack, exactly as Blender and Houdini do it, so the modifier must
  // carry none — and the Object must still put the result in the right place. Both
  // halves are asserted: the absence alone would pass on a modifier that drew nothing,
  // and the placement alone would pass on one that had wrongly kept a pose.
  it('carries NO pose itself, and the OBJECT still poses the result (the split, both ways)', () => {
    const { state, modifierId, objectId } = splitCubeWithArray({ position: [5, 0, 0] });

    const out = evaluate(state, modifierId).value as ObjectData;
    expect(out.kind).toBe('ModifiedData');
    expect(out).not.toHaveProperty('position');

    // Blender/Houdini order: mesh data → modifier stack → object transform. The Object
    // wears the modified data and supplies the one pose.
    const posed = evaluate(state, objectId).value as {
      kind: string;
      position: [number, number, number];
      data: ObjectData | null;
    };
    expect(posed.kind).toBe('Object');
    expect(posed.data?.kind).toBe('ModifiedData');
    expect(posed.position).toEqual([5, 0, 0]);
  });

  it("inherits the DATA node's material (geometry and material both live on the data)", () => {
    const { state, modifierId } = splitCubeWithArray({ color: '#ff0000' });
    const out = evaluate(state, modifierId).value as {
      material: { base: { color: string } } | null;
    };
    expect(out.material?.base.color).toBe('#ff0000');
  });

  it('offers modifiers on a cube — the offer is the accept condition (V108)', () => {
    const { state, objectId, dataId } = splitCubeWithArray();
    // #415 — the offer is a question about the DATA, reached from the selected Object
    // through the same `resolveStackBase` hop the panel takes.
    expect(resolveStackBase(state, objectId)).toBe(dataId);
    expect(canModifyGeometry(state, dataId)).toBe(true);
  });

  // #388 C5 — THE PAIR THAT WAS SILENTLY BROKEN, and the reason this file gained a case.
  // `modifierSource`'s Object arm used to narrow with `data.kind !== 'MeshData'`. An
  // inequality guard is ALREADY TOTAL, so adding `BakedData` to the `ObjectData` union
  // could not redden it: a baked pair fell through to `return null` and BOTH halves of
  // V108 dropped together — the "+ Add Modifier" affordance vanished at exactly the
  // moment the modifier stopped working, which reads as deliberate product design rather
  // than a regression.
  //
  // ⚠️ THIS CASE HAS NOW BEEN RE-ANCHORED TWICE, and both times it came out stricter.
  // First: it was written as `expect(pair).toEqual(modifierSource(fusedValue))`, with the
  // fused `BakedMesh` as the natural control — retiring that node made its `evaluate`
  // throw, so the comparison became impossible and was replaced by the CANONICAL struct
  // (the pair must produce THIS source, not merely "whatever the relic used to say").
  // Second, here: #415 slice 4 deleted `modifierSource` itself, so the subject moves from
  // the posed Object to the DATA node the stack actually sits on. What the move buys is
  // the third assertion below — the source's SHAPE. The old form could not state that a
  // modifier source carries no pose, because the function it called returned one.
  it('offers modifiers on a baked PAIR — the guard that absorbed it in silence (#388)', () => {
    const geometry = {
      key: 'baked|pair-8',
      kind: 'baked' as const,
      descriptor: { kind: 'baked' as const, hash: 'pair', vertexCount: 8 },
    };
    const material = { ...(rowDataParams('baked').material as Record<string, unknown>) };

    let s: DagState = emptyDagState();
    for (const op of splitOps(
      'baked',
      { objectId: 'n_pair' },
      { data: { geometry, material }, object: { position: [1, 2, 3] } },
    )) {
      s = applyOp(s, op as never).next;
    }

    // #415 — the stack sits on the DATA lane, so the source is classified there. The id
    // is read off the edge (`resolveStackBase`) rather than spelled out, because the
    // data-id convention has three spellings in this repo and deriving it by hand is how
    // a test ends up asserting against a node nobody wired.
    const dataId = resolveStackBase(s, 'n_pair');
    const src = modifierDataSource(evaluate(s, dataId).value as ObjectData);
    expect(src).not.toBeNull();
    // The buffer handle and the captured spec ride through VERBATIM.
    expect(src).toEqual({ geometry, material });
    // …and NOTHING ELSE rides through. The Object is posed at [1,2,3] and a modifier
    // source must not see it: on the data lane the pose is applied once, above the whole
    // stack. `toEqual` above already pins the exact shape, but state it by name — this is
    // the claim the deleted `modifierSource` could not make, since it returned a pose.
    expect(src).not.toHaveProperty('transform');
    expect(src).not.toHaveProperty('position');

    // V108 — offer == accept. Both halves ask the SAME function, which is why they went
    // wrong together and stayed consistent while doing it: a uniformly absent affordance
    // reads as design. Assert the offer explicitly rather than trusting that agreement.
    expect(canModifyGeometry(s, dataId)).toBe(true);
  });

  it('does not offer modifiers on an Empty (an Object with no data)', () => {
    const s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_empty',
      nodeType: 'Object',
      params: {},
    }).next;
    // #415 — an Empty has no data lane to resolve onto, so the base walk stops at the
    // Object itself. That is asserted rather than left implicit: without it, the `false`
    // below would be indistinguishable from "an Object is never a base", which is a
    // different (and much weaker) statement that would hold even for a real cube.
    expect(resolveStackBase(s, 'n_empty')).toBe('n_empty');
    expect(canModifyGeometry(s, 'n_empty')).toBe(false);

    // …and the accept half agrees — offer and accept cannot drift apart (V108). #415
    // slice 4 RE-ANCHORED this. It used to ask `modifierSource(evaluate(...))` and expect
    // null, which was the right question while a modifier consumed scene values. That
    // function is gone, and the reason it is gone is the stronger statement: an Object
    // emits `SceneObject`, the modifier's `target` takes `ObjectData`, and `ops.ts`
    // compares socket types by exact string equality. The refusal is now STRUCTURAL —
    // there is no wiring to classify, so the offer's `false` cannot be a classifier
    // disagreeing with a graph that was allowed to exist.
    const withArr = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_arr',
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [2, 0, 0] },
    }).next;
    expect(() =>
      applyOp(withArr, {
        type: 'connect',
        from: { node: 'n_empty', socket: 'out' },
        to: { node: 'n_arr', socket: 'target' },
      }),
    ).toThrow(/type mismatch/);
  });

  // #415 — RE-ANCHORED. This used to feed the modifier a Group, which is now REFUSED at
  // the connect check rather than passed through (a Group emits `SceneObject`; `target`
  // takes `ObjectData`). Both halves of the old case survive, on the shapes that can
  // still occur — and the refusal itself is asserted, because a wiring that silently
  // succeeded would be the real regression.
  it('non-mesh data passes through unchanged; a scene object cannot even be wired', () => {
    let s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_curve_data',
      nodeType: 'CurveData',
      params: { closed: false }, // points default to the schema's four-point arc
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_arr',
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [2, 0, 0] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_curve_data', socket: 'out' },
      to: { node: 'n_arr', socket: 'target' },
    }).next;
    // A curve is not a mesh face — nothing for a geometry modifier to reshape, so it
    // rides through untouched and is not offered.
    expect(canModifyGeometry(s, 'n_curve_data')).toBe(false);
    expect((evaluate(s, 'n_arr').value as ObjectData).kind).toBe('CurveData');

    // …and a Group can no longer reach the socket at all. `ops.ts` compares socket types
    // by exact string equality — no widening, no compatibility rule — which is what
    // makes the old passthrough case unreachable rather than merely unused.
    const withGroup = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_group',
      nodeType: 'Group',
      params: {},
    }).next;
    expect(() =>
      applyOp(withGroup, {
        type: 'connect',
        from: { node: 'n_group', socket: 'out' },
        to: { node: 'n_arr', socket: 'target' },
      }),
    ).toThrow(/type mismatch/);
  });

  it('reports not-modifiable rather than throwing when the source cannot evaluate', () => {
    // `evaluate` throws on a dangling input ref, and this predicate runs inside a
    // React render — the type-set lookup it replaced could not throw at all. An
    // un-evaluable source must degrade to the banner, never unmount the panel.
    //
    // #415 — the SUBJECT had to move to keep the case meaningful. Deleting the data
    // node out from under the Object no longer exercises anything: an Object is not a
    // data node, so the predicate now answers `false` from the registry check without
    // ever calling `evaluate`, and the test would pass without the try/catch existing.
    // A modifier IS a valid base (you can stack on one), so a modifier with a dangling
    // `target` is the shape that still reaches the throw.
    const seeded = splitCubeWithArray();
    const broken: DagState = {
      ...seeded.state,
      nodes: Object.fromEntries(
        Object.entries(seeded.state.nodes).filter(([id]) => id !== seeded.dataId),
      ),
    };
    expect(() => evaluate(broken, seeded.modifierId)).toThrow(); // the hazard is real
    expect(() => canModifyGeometry(broken, seeded.modifierId)).not.toThrow();
    expect(canModifyGeometry(broken, seeded.modifierId)).toBe(false);
  });

  it('a muted modifier is still an identity passthrough on a split source (V58)', () => {
    const seeded = splitCubeWithArray();
    const s = applyOp(seeded.state, {
      type: 'setParam',
      nodeId: seeded.modifierId,
      paramPath: 'muted',
      value: true,
    }).next;
    // Muted → the SOURCE DATA rides through verbatim (it used to be the Object, because
    // the Object used to be what the modifier consumed).
    expect((evaluate(s, seeded.modifierId).value as ObjectData).kind).toBe('MeshData');
  });
});

// #498 — `resolveDataKind`, the fact the OFFER needs that `canModifyGeometry` cannot give.
describe('#498 resolveDataKind — the kind, not just the boolean', () => {
  beforeEach(() => {
    __reseedAllNodesForTests();
  });

  it('names each data kind in the default project, and refuses non-data nodes', () => {
    const state = buildDefaultDagState();
    expect(resolveDataKind(state, 'n_box_data')).toBe('MeshData');
    expect(resolveDataKind(state, 'n_camera_data')).toBe('CameraData');
    expect(resolveDataKind(state, 'n_light_data')).toBe('LightData');

    // The Object is NOT a data node — it emits 'SceneObject'. Returning its kind here
    // would make the panel classify the wrong half of the pair.
    expect(resolveDataKind(state, 'n_box')).toBeNull();
    expect(resolveDataKind(state, 'nonexistent')).toBeNull();
  });

  it('agrees with canModifyGeometry about which kinds are modifiable', () => {
    // The two are read together by the panel — one picks the buttons, the other the
    // sentence. If they disagreed the panel would say one thing and do another.
    const state = buildDefaultDagState();
    for (const id of ['n_box_data', 'n_camera_data', 'n_light_data']) {
      const kind = resolveDataKind(state, id);
      expect(kind, `${id} must resolve to a kind`).not.toBeNull();
      const modifiable = canModifyGeometry(state, id);
      expect(modifiable).toBe(kind === 'MeshData');
    }
  });
});

// FALSIFICATION (run by hand, not automatable without breaking the build):
// adding a kind to the `ObjectData` union without an arm in `modifierDataSource` fails
// typecheck at the `never` assertion — TS2322, "not assignable to type 'never'".
// Do not add a `default:` arm to restore it; that is the bug this closes.
//
// #415 slice 4 — the gate MOVED unions with the classifier. It used to close over
// `SceneChild` (every posed scene value) and now closes over `ObjectData` (the data lane
// alone), which is a narrowing, and a narrowed gate is indistinguishable from a weakened
// one by inspection. What makes it still load-bearing: `ObjectData` is the union every
// modifier source is drawn from now, because `target` takes that socket and nothing else
// can reach it. The union that shrank is exactly the set of values that can no longer be
// wired to a modifier at all — asserted directly by the two `type mismatch` cases above.

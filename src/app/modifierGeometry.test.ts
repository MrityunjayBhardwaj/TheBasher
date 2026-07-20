// modifierGeometry — the ONE kind-dispatch for "can this be modified, and with what?"
// (#377, epic #365 Stage B). The cases below pin the two things that were broken on
// `main` and the one structural guard that keeps them from breaking again:
//
//   1. THE BOUNDARY PAIR. A modifier on a split cube resolved as a real array on the
//      READ road (`resolveEvaluatedMesh` gained an `Object` branch in #362) and passed
//      THROUGH unchanged on the RENDER road (`evaluate`, which never did). Read and
//      render disagreed with nothing to catch it. The pair is asserted directly:
//      the two roads must produce the SAME geometry key (H40, one band).
//   2. THE OFFER. `canModifyGeometry` is the predicate the UI gates on, and it is the
//      predicate `evaluate` accepts — V108. A cube must be offered modifiers.
//   3. THE `never` GATE. `modifierSource` has no `default:` arm, so a new SceneChild
//      kind fails to compile until its answer is declared (V109). Stage C puts five
//      more data kinds behind `Object`; this is what stops each one being a silent
//      passthrough. Verified by falsification, noted at the bottom.
//
// REF: src/app/modifierGeometry.ts; src/app/resolveEvaluatedMesh.ts; src/nodes/ArrayModifier.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { emptyDagState, applyOp, type DagState } from '../core/dag';
import { evaluate } from '../core/dag/evaluator';
import { __reseedAllNodesForTests } from '../nodes/registerAll';
import { makeSplitCube } from '../test-utils/splitCube';
import { canModifyGeometry, modifierSource } from './modifierGeometry';
import { resolveEvaluatedMesh } from './resolveEvaluatedMesh';
import type { SceneChild } from '../nodes/types';

/** A split cube with an ArrayModifier wired onto it. Returns the ids. */
function splitCubeWithArray(opts: { position?: [number, number, number]; color?: string } = {}) {
  const seeded = makeSplitCube(emptyDagState(), {
    objectId: 'n_box',
    size: [1, 1, 1],
    position: opts.position,
    color: opts.color,
  });
  let s: DagState = seeded.state;
  s = applyOp(s, {
    type: 'addNode',
    nodeId: 'n_arr',
    nodeType: 'ArrayModifier',
    params: { count: 4, offset: [2, 0, 0] },
  }).next;
  s = applyOp(s, {
    type: 'connect',
    from: { node: seeded.objectId, socket: 'out' },
    to: { node: 'n_arr', socket: 'target' },
  }).next;
  return { state: s, objectId: seeded.objectId, dataId: seeded.dataId, modifierId: 'n_arr' };
}

describe('modifierGeometry — a modifier attaches to the Object and reshapes its data (#377)', () => {
  beforeEach(() => __reseedAllNodesForTests());

  it('read and render agree on a split-Object source (the pair that was broken)', () => {
    const { state, modifierId } = splitCubeWithArray();

    const rendered = evaluate(state, modifierId).value as SceneChild;
    const read = resolveEvaluatedMesh(state, modifierId);

    // Before the fix the render road returned the Object VERBATIM (kind 'Object',
    // geometry 'box|1,1,1') while the read road returned the array.
    expect(rendered.kind).toBe('ModifiedMesh');
    expect(read).not.toBeNull();
    expect((rendered as { geometry: { key: string } }).geometry.key).toBe(
      'array|box|1,1,1|4|2,0,0',
    );
    // The one band: both roads build the identical deterministic key.
    expect((rendered as { geometry: { key: string } }).geometry.key).toBe(read!.geometry.key);
  });

  it("inherits the OBJECT's pose, not the data node's (a data node has no transform)", () => {
    const { state, modifierId } = splitCubeWithArray({ position: [5, 0, 0] });
    const out = evaluate(state, modifierId).value as {
      kind: string;
      position: [number, number, number];
    };
    // The kind assertion is load-bearing: a PASSED-THROUGH Object carries the very
    // same position, so asserting the pose alone passes even with the fix removed.
    expect(out.kind).toBe('ModifiedMesh');
    // Blender/Houdini order: mesh data → modifier stack → object transform. The
    // modified geometry sits where the Object was posed.
    expect(out.position).toEqual([5, 0, 0]);
  });

  it("inherits the DATA node's material (geometry and material both live on the data)", () => {
    const { state, modifierId } = splitCubeWithArray({ color: '#ff0000' });
    const out = evaluate(state, modifierId).value as {
      material: { base: { color: string } } | null;
    };
    expect(out.material?.base.color).toBe('#ff0000');
  });

  it('offers modifiers on a cube — the offer is the accept condition (V108)', () => {
    const { state, objectId } = splitCubeWithArray();
    expect(canModifyGeometry(state, objectId)).toBe(true);
  });

  it('does not offer modifiers on an Empty (an Object with no data)', () => {
    const s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_empty',
      nodeType: 'Object',
      params: {},
    }).next;
    expect(canModifyGeometry(s, 'n_empty')).toBe(false);
    // ...and the modifier itself agrees — offer and accept cannot drift apart.
    const value = evaluate(s, 'n_empty').value as SceneChild;
    expect(modifierSource(value)).toBeNull();
  });

  it('a modifier passes an unmodifiable source through unchanged', () => {
    let s = applyOp(emptyDagState(), {
      type: 'addNode',
      nodeId: 'n_group',
      nodeType: 'Group',
      params: {},
    }).next;
    s = applyOp(s, {
      type: 'addNode',
      nodeId: 'n_arr',
      nodeType: 'ArrayModifier',
      params: { count: 4, offset: [2, 0, 0] },
    }).next;
    s = applyOp(s, {
      type: 'connect',
      from: { node: 'n_group', socket: 'out' },
      to: { node: 'n_arr', socket: 'target' },
    }).next;
    expect(canModifyGeometry(s, 'n_group')).toBe(false);
    expect((evaluate(s, 'n_arr').value as SceneChild).kind).toBe('Group');
  });

  it('reports not-modifiable rather than throwing when the source cannot evaluate', () => {
    // `evaluate` throws on a dangling input ref, and this predicate runs inside a
    // React render — the type-set lookup it replaced could not throw at all. An
    // un-evaluable source must degrade to the banner, never unmount the panel.
    const seeded = makeSplitCube(emptyDagState(), { objectId: 'n_box', size: [1, 1, 1] });
    // Delete the data node out from under the Object, leaving a dangling `data` ref.
    const broken: DagState = {
      ...seeded.state,
      nodes: Object.fromEntries(
        Object.entries(seeded.state.nodes).filter(([id]) => id !== seeded.dataId),
      ),
    };
    expect(() => canModifyGeometry(broken, seeded.objectId)).not.toThrow();
    expect(canModifyGeometry(broken, seeded.objectId)).toBe(false);
  });

  it('a muted modifier is still an identity passthrough on a split source (V58)', () => {
    const seeded = splitCubeWithArray();
    const s = applyOp(seeded.state, {
      type: 'setParam',
      nodeId: seeded.modifierId,
      paramPath: 'muted',
      value: true,
    }).next;
    expect((evaluate(s, seeded.modifierId).value as SceneChild).kind).toBe('Object');
  });
});

// FALSIFICATION (run by hand, not automatable without breaking the build):
// adding a kind to the `SceneChild` union without an arm in `modifierSource` fails
// typecheck at the `never` assertion — TS2322, "not assignable to type 'never'".
// Do not add a `default:` arm to restore it; that is the bug this closes.

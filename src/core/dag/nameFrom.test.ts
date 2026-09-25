// #1122 — a node whose name follows another's (`meta.nameFrom`), at the reducer.
//
// The rule lives in `applyOp` because that is the one road every name change takes: the
// inspector's `setParam` (a variable path no search can list), a re-cook's bake, an agent's
// batch, undo and redo. These rows pin the rule there; the roads that USE it (an imported and
// a generated motion's stand-in Object) are pinned where those roads are tested.
//
// Two of the three behaviours #1122 weighed are each refused by a row below:
//   • "leave the name alone"        — refused by `follows a rename of the source`
//   • "derive the name at display"  — refused by `a rename cuts the link`, whose name stays put
//     while the source moves on (a display-time derivation would show the source's name).

import { beforeEach, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../../nodes/registerAll';
import { applyOp } from './ops';
import { emptyDagState } from './state';
import type { DagState } from './state';
import type { Op } from './types';

function apply(s: DagState, ops: readonly Op[]): DagState {
  return ops.reduce((acc, op) => applyOp(acc, op).next, s);
}

/** Apply one op and hand back its inverse too, so a row can undo exactly what it did. */
function step(s: DagState, op: Op): { next: DagState; inverse: Op } {
  const { next, inverse } = applyOp(s, op);
  return { next, inverse };
}

const clipName = (s: DagState, id = 'clip') => (s.nodes[id].params as { name: string }).name;

/** A clip, an Object following it, and a bystander Object that follows nothing. */
function graph(): DagState {
  return apply(emptyDagState(), [
    { type: 'addNode', nodeId: 'clip', nodeType: 'AnimationClip', params: { name: 'soma-walk' } },
    { type: 'addNode', nodeId: 'rig', nodeType: 'Object', params: {} },
    { type: 'setMeta', nodeId: 'rig', name: 'soma-walk', nameFrom: 'clip' },
    { type: 'addNode', nodeId: 'box', nodeType: 'Object', params: {} },
    { type: 'setMeta', nodeId: 'box', name: 'soma-walk' },
  ]);
}

describe('meta.nameFrom — a name that follows another node’s (#1122)', () => {
  beforeEach(() => registerAllNodes());

  it('follows a rename of the source, and only the follower moves', () => {
    const s = apply(graph(), [
      { type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'hero walk' },
    ]);
    expect(s.nodes.rig.meta).toEqual({ name: 'hero walk', nameFrom: 'clip' });
    // Same starting name, no link: a coincidence of strings is not a link.
    expect(s.nodes.box.meta).toEqual({ name: 'soma-walk' });
  });

  it('follows the source’s meta.name too — its outliner rename is its name', () => {
    const s = apply(graph(), [{ type: 'setMeta', nodeId: 'clip', name: 'jog' }]);
    expect(s.nodes.rig.meta?.name).toBe('jog');
  });

  it('does not copy a blank name — blank is the unnamed state, not a label', () => {
    const s = apply(graph(), [
      { type: 'setParam', nodeId: 'clip', paramPath: 'name', value: '  ' },
    ]);
    expect(s.nodes.rig.meta).toEqual({ name: 'soma-walk', nameFrom: 'clip' });
  });

  it('a link takes the source’s current name when it is written, not the one passed', () => {
    const s = apply(graph(), [
      { type: 'addNode', nodeId: 'late', nodeType: 'Object', params: {} },
      { type: 'setMeta', nodeId: 'late', name: 'stale', nameFrom: 'clip' },
    ]);
    expect(s.nodes.late.meta).toEqual({ name: 'soma-walk', nameFrom: 'clip' });
  });

  it('a rename cuts the link: the source moves on and the chosen name stays', () => {
    // The outliner's rename is exactly this op (`RenameInput.tsx`): a name and no link.
    let s = apply(graph(), [{ type: 'setMeta', nodeId: 'rig', name: 'my rig' }]);
    expect(s.nodes.rig.meta).toEqual({ name: 'my rig' });
    s = apply(s, [{ type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'hero walk' }]);
    expect(clipName(s)).toBe('hero walk');
    expect(s.nodes.rig.meta).toEqual({ name: 'my rig' });
  });

  it('undoing the rename resumes following, at the name the source has NOW', () => {
    const renamed = step(graph(), { type: 'setMeta', nodeId: 'rig', name: 'my rig' });
    expect(renamed.inverse).toEqual({
      type: 'setMeta',
      nodeId: 'rig',
      name: 'soma-walk',
      nameFrom: 'clip',
    });
    // The source moves while the rename stands (the order an agent's fork can replay in).
    let s = apply(renamed.next, [
      { type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'hero walk' },
    ]);
    s = apply(s, [renamed.inverse]);
    expect(s.nodes.rig.meta).toEqual({ name: 'hero walk', nameFrom: 'clip' });
    s = apply(s, [{ type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'run' }]);
    expect(s.nodes.rig.meta?.name).toBe('run');
  });

  it('undoing the source’s rename carries the follower back with it', () => {
    const renamed = step(graph(), {
      type: 'setParam',
      nodeId: 'clip',
      paramPath: 'name',
      value: 'hero walk',
    });
    expect(renamed.next.nodes.rig.meta?.name).toBe('hero walk');
    const s = apply(renamed.next, [renamed.inverse]);
    expect(s.nodes.rig.meta).toEqual({ name: 'soma-walk', nameFrom: 'clip' });
  });

  it('a node that never had a link writes meta exactly as before — no key appears', () => {
    const { next, inverse } = step(graph(), { type: 'setMeta', nodeId: 'box', name: 'crate' });
    expect(next.nodes.box.meta).toEqual({ name: 'crate' });
    expect(inverse).toEqual({ type: 'setMeta', nodeId: 'box', name: 'soma-walk' });
  });

  it('a node cannot follow itself', () => {
    const s = apply(graph(), [{ type: 'setMeta', nodeId: 'box', name: 'crate', nameFrom: 'box' }]);
    expect(s.nodes.box.meta).toEqual({ name: 'crate' });
  });

  it('one hop: a follower’s own follower is not walked', () => {
    let s = apply(graph(), [
      { type: 'addNode', nodeId: 'far', nodeType: 'Object', params: {} },
      { type: 'setMeta', nodeId: 'far', name: 'soma-walk', nameFrom: 'rig' },
    ]);
    s = apply(s, [{ type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'hero walk' }]);
    expect(s.nodes.rig.meta?.name).toBe('hero walk');
    expect(s.nodes.far.meta?.name).toBe('soma-walk');
  });

  it('removing the source leaves the follower its last name', () => {
    let s = apply(graph(), [
      { type: 'setParam', nodeId: 'clip', paramPath: 'name', value: 'hero walk' },
    ]);
    // The link is not an edge, so nothing refuses the removal.
    s = apply(s, [{ type: 'removeNode', nodeId: 'clip' }]);
    expect(s.nodes.rig.meta?.name).toBe('hero walk');
  });
});

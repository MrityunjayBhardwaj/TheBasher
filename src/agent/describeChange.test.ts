// describeChange (#1612) — the agent's change in a director's words, built from the ops the real
// add builders emit, so a change to how a kind is built shows up here rather than in the chat.

import { describe, expect, it } from 'vitest';
import { __resetRegistryForTests } from '../core/dag';
import { registerAllNodes } from '../nodes/registerAll';
import { applyOp } from '../core/dag/ops';
import { buildDefaultDagState } from '../core/project/default';
import { buildAddPrimitiveOps, type SceneObjectKind } from '../app/addPrimitives';
import type { DagState } from '../core/dag/state';
import type { Op } from '../core/dag/types';
import { describeChange } from './describeChange';

__resetRegistryForTests();
registerAllNodes();

/** The ops for adding each kind in turn, each built against the state the last one left. */
function adds(kinds: SceneObjectKind[]): { before: DagState; ops: Op[] } {
  const before = buildDefaultDagState();
  let state = before;
  const ops: Op[] = [];
  kinds.forEach((kind, i) => {
    const r = buildAddPrimitiveOps(state, kind, [i * 2, 0, 0])!;
    for (const op of r.ops) state = applyOp(state, op).next;
    ops.push(...r.ops);
  });
  return { before, ops };
}

describe('describeChange', () => {
  it('three cubes read as three cubes, not as twelve ops or three tool calls', () => {
    const { before, ops } = adds(['Cube', 'Cube', 'Cube']);
    expect(ops.length).toBeGreaterThan(3);
    expect(describeChange(before, ops)).toBe('Added 3 cubes');
  });

  it('each kind added on its own reads as one thing with its own word', () => {
    const words: [SceneObjectKind, string][] = [
      ['Cube', 'Added a cube'],
      ['Sphere', 'Added a sphere'],
      ['AreaLight', 'Added an area light'],
      ['PointLight', 'Added a point light'],
      ['AmbientLight', 'Added an ambient light'],
      ['PerspectiveCamera', 'Added a camera'],
      ['Null', 'Added an empty'],
      ['Curve', 'Added a path'],
      ['Armature', 'Added an armature'],
    ];
    for (const [kind, sentence] of words) {
      const { before, ops } = adds([kind]);
      expect(describeChange(before, ops), kind).toBe(sentence);
    }
  });

  it('mixed adds keep their order and their counts', () => {
    const { before, ops } = adds(['Cube', 'AreaLight', 'Cube']);
    expect(describeChange(before, ops)).toBe('Added 2 cubes and an area light');
  });

  it('an edit to a data half is named by the object a person sees', () => {
    const before = buildDefaultDagState();
    const ops = [
      { type: 'setParam', nodeId: 'n_box_data', paramPath: 'size', value: [2, 2, 2] },
      { type: 'setParam', nodeId: 'n_box', paramPath: 'position', value: [1, 0, 0] },
    ] as Op[];
    expect(describeChange(before, ops)).toBe('Changed n_box');
  });

  it('removing an object and its data half names the object once', () => {
    const before = buildDefaultDagState();
    const ops = [
      { type: 'removeNode', nodeId: 'n_box' },
      { type: 'removeNode', nodeId: 'n_box_data' },
    ] as Op[];
    expect(describeChange(before, ops)).toBe('Removed n_box');
  });

  it('an add and an edit in one batch say both, and never an id that was just minted', () => {
    const { before, ops } = adds(['Cube']);
    const all = [
      ...ops,
      { type: 'setParam', nodeId: 'n_light', paramPath: 'position', value: [0, 5, 0] },
    ] as Op[];
    const s = describeChange(before, all);
    expect(s).toBe('Added a cube, changed n_light');
    for (const op of ops) if (op.type === 'addNode') expect(s).not.toContain(op.nodeId);
  });

  it('no ops, no sentence', () => {
    expect(describeChange(buildDefaultDagState(), [])).toBe('');
  });
});

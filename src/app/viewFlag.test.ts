// #1953 — the view flag: which nodes carry one, and what the viewport draws while one is set.

import { beforeAll, describe, expect, it } from 'vitest';
import { registerAllNodes } from '../nodes/registerAll';
import { buildDefaultDagState } from '../core/project/default';
import { applyOps } from '../core/dag/ops';
import { evaluate } from '../core/dag/evaluator';
import type { DagState } from '../core/dag/state';
import { buildAddModifierOps } from './operatorStack';
import { viewedObjectOf, viewedState, viewFlagOf } from './viewFlag';

beforeAll(() => registerAllNodes());

/** The default scene with an Array (count 4) on the box: BoxData → Array → Object. */
function withArray(): { state: DagState; arrayId: string } {
  const base = buildDefaultDagState();
  const add = buildAddModifierOps(base, 'n_box_data', 'ArrayModifier', { count: 4 }, 'arr');
  if (!add) throw new Error('could not add an Array');
  return { state: applyOps(base, add.ops).next, arrayId: add.modifierId };
}

/** What the object draws, as the evaluator hands it over: its data's kind and, for modified
 *  geometry, the outermost operation (an `array` descriptor carries its count). */
function drawn(state: DagState, objectId: string): string {
  const data = (evaluate(state, objectId).value as { data?: Record<string, unknown> }).data;
  if (!data) throw new Error(`${objectId} draws no data`);
  const d = (data.geometry as { descriptor?: { kind: string; count?: number } } | undefined)
    ?.descriptor;
  return d
    ? `${String(data.kind)}:${d.kind}${d.count !== undefined ? `×${d.count}` : ''}`
    : String(data.kind);
}

describe('viewFlagOf — #1953 which nodes carry a flag', () => {
  it('an object end is its final result; a step on its data lane is a step', () => {
    const { state, arrayId } = withArray();
    expect(viewFlagOf(state, 'n_box')).toBe('final');
    expect(viewFlagOf(state, arrayId)).toBe('step');
    expect(viewFlagOf(state, 'n_box_data')).toBe('step');
  });

  it('a constraint, the scene, the render output and the clock carry none', () => {
    const s = buildDefaultDagState();
    for (const id of ['n_light_aim', 'n_light_own_world', 'n_scene', 'n_render', 'n_time'])
      expect(viewFlagOf(s, id), id).toBeNull();
    expect(viewFlagOf(s, 'missing')).toBeNull();
  });
});

describe('viewedState — what the viewport draws while a node is flagged', () => {
  it('nothing flagged, or the object end: the same graph object', () => {
    const { state } = withArray();
    expect(viewedState(state, null)).toBe(state);
    expect(viewedState(state, 'n_box')).toBe(state);
    expect(viewedState(state, 'n_light_aim')).toBe(state);
  });

  it('a step: the object wears that step’s result, and the real graph is untouched', () => {
    const { state, arrayId } = withArray();
    const before = JSON.stringify(state.nodes.n_box.inputs);
    expect(viewedObjectOf(state, 'n_box_data')).toBe('n_box');
    expect(drawn(state, 'n_box')).toBe('ModifiedData:array×4');
    const viewed = viewedState(state, 'n_box_data');
    expect(viewed.nodes.n_box.inputs.data).toEqual({ node: 'n_box_data', socket: 'out' });
    // Viewing the box: the object wears the plain box, not the four the Array makes.
    expect(drawn(viewed, 'n_box')).toBe('MeshData:box');
    expect(drawn(viewed, 'n_box')).not.toContain('array');
    // Viewing the Array itself is the final result (nothing sits above it).
    expect(drawn(viewedState(state, arrayId), 'n_box')).toBe('ModifiedData:array×4');
    expect(JSON.stringify(state.nodes.n_box.inputs)).toBe(before);
  });
});
